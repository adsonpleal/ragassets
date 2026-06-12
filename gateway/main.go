// zrenderer-gateway is a fast, public, caching HTTP layer in front of
// zhad3/zrenderer (https://github.com/zhad3/zrenderer). It does no image
// processing of its own: it maps query parameters to a zrenderer RenderRequest,
// asks zrenderer to render, then caches and serves the resulting PNG/APNG bytes.
//
// All actual sprite rendering is done by zrenderer. This is just a layer on top.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Configuration (from environment, with sane defaults for docker-compose)
// ---------------------------------------------------------------------------

type config struct {
	zrendererURL string
	tokenFile    string
	tokenEnv     string
	outputDir    string
	cacheDir     string
	iconsDir     string
	port         string
}

func loadConfig() config {
	return config{
		zrendererURL: env("ZRENDERER_URL", "http://zrenderer:11011"),
		tokenFile:    env("TOKEN_FILE", "/secrets/accesstokens.conf"),
		tokenEnv:     os.Getenv("ZRENDERER_TOKEN"),
		outputDir:    env("OUTPUT_DIR", "/zren/output"),
		cacheDir:     env("CACHE_DIR", "/cache"),
		iconsDir:     env("ICONS_DIR", "/icons"),
		port:         env("GATEWAY_PORT", "8080"),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type server struct {
	cfg    config
	client *http.Client
	tokens *tokenLoader
	flight *flightGroup
}

func main() {
	cfg := loadConfig()
	if err := os.MkdirAll(cfg.cacheDir, 0o755); err != nil {
		log.Fatalf("cannot create cache dir %q: %v", cfg.cacheDir, err)
	}

	s := &server{
		cfg:    cfg,
		client: &http.Client{Timeout: 120 * time.Second},
		tokens: &tokenLoader{file: cfg.tokenFile, override: cfg.tokenEnv},
		flight: newFlightGroup(),
	}

	if fi, err := os.Stat(cfg.iconsDir); err != nil || !fi.IsDir() {
		log.Printf("icons: %s not found — /icons/* will return 404 (run extract-grf.mjs --icons)", cfg.iconsDir)
	} else {
		log.Printf("icons: serving %s at /icons/{type}/{id}.png", cfg.iconsDir)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/image", s.handleImage)
	mux.HandleFunc("/icons/", s.handleIcon)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok")
	})
	mux.HandleFunc("/", s.handleRoot)

	addr := ":" + cfg.port
	log.Printf("zrenderer-gateway listening on %s → %s (cache: %s)", addr, cfg.zrendererURL, cfg.cacheDir)
	srv := &http.Server{
		Addr:         addr,
		Handler:      logRequests(mux),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 130 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}

func (s *server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, "zrenderer-gateway — a caching layer over zhad3/zrenderer.\n\n"+
		"Try: /image?job=1002            (still image)\n"+
		"     /image?job=1002&action=0   (animation, APNG)\n"+
		"     /icons/item/501.png        (static item/collection/skill/job icons)\n\n"+
		"See the README for every supported parameter.\n")
}

// ---------------------------------------------------------------------------
// /image handler
// ---------------------------------------------------------------------------

func (s *server) handleImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query()

	body, ext, err := buildRenderRequest(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	key := cacheKey(q)
	cachePath := filepath.Join(s.cfg.cacheDir, key+ext)
	contentType := contentTypeForExt(ext)

	// Fast path: already cached.
	if fileExists(cachePath) {
		s.serveFile(w, r, cachePath, key, contentType)
		return
	}

	// Slow path: render once even under concurrent identical requests.
	_, err = s.flight.Do(key, func() (struct{}, error) {
		if fileExists(cachePath) {
			return struct{}{}, nil // produced while we waited for the lock
		}
		return struct{}{}, s.render(body, cachePath)
	})
	if err != nil {
		log.Printf("render failed for %s: %v", r.URL.RawQuery, err)
		http.Error(w, "render failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	s.serveFile(w, r, cachePath, key, contentType)
}

// serveFile streams a cached render with immutable cache headers and conditional
// request support (ETag / 304).
func (s *server) serveFile(w http.ResponseWriter, r *http.Request, path, key, contentType string) {
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "cache read error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		http.Error(w, "cache stat error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Etag", `"`+key+`"`)
	// http.ServeContent honors If-None-Match against the Etag we set, plus ranges.
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// ---------------------------------------------------------------------------
// /icons handler — static item/collection/skill/job icons extracted from the
// client GRF by extract-grf.mjs --icons. No zrenderer involvement.
// ---------------------------------------------------------------------------

// The kinds and the digits-only ids mirror what extract-grf.mjs --icons
// produces (<icons-dir>/{item,collection,skill,job}/<numeric id>.png) — keep
// them in sync with extractIcons() there.
var iconKinds = map[string]bool{"item": true, "collection": true, "skill": true, "job": true}
var iconFilePattern = regexp.MustCompile(`^[0-9]+\.png$`)

// handleIcon serves /icons/{type}/{id}.png from the icons dir. The kind
// whitelist plus the digits-only filename pattern make path traversal
// structurally impossible; anything else is a 404.
func (s *server) handleIcon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/icons/"), "/")
	if len(parts) != 2 || !iconKinds[parts[0]] || !iconFilePattern.MatchString(parts[1]) {
		http.NotFound(w, r)
		return
	}

	path := filepath.Join(s.cfg.iconsDir, parts[0], parts[1])
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		http.NotFound(w, r) // unknown id, or icons not extracted yet
		return
	}

	// Icons are re-extracted in place, so derive the ETag from mtime+size
	// (renders use their query hash instead).
	etag := fmt.Sprintf("%x-%x", fi.ModTime().UnixNano(), fi.Size())
	s.serveFile(w, r, path, etag, "image/png")
}

// ---------------------------------------------------------------------------
// Rendering: query → RenderRequest → zrenderer → cache file
// ---------------------------------------------------------------------------

// render asks zrenderer to render `body`, then copies the produced file from the
// shared output volume into cachePath (atomically).
func (s *server) render(body map[string]any, cachePath string) error {
	token, err := s.tokens.get()
	if err != nil {
		return fmt.Errorf("access token unavailable: %w", err)
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(s.cfg.zrendererURL, "/")+"/render", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-accesstoken", token)

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("calling zrenderer: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		s.tokens.invalidate() // token may have been rotated; reload next time
		return fmt.Errorf("zrenderer rejected the access token (401)")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("zrenderer returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var rr struct {
		Output []string `json:"output"`
	}
	if err := json.Unmarshal(respBody, &rr); err != nil {
		return fmt.Errorf("decoding zrenderer response: %w", err)
	}
	if len(rr.Output) == 0 {
		return errors.New("zrenderer produced no output")
	}

	srcPath := s.resolveOutputPath(rr.Output[0])
	return copyToCache(srcPath, cachePath)
}

// resolveOutputPath maps a zrenderer output path (e.g. "output/1002/abc.png")
// to a file on the shared output volume mounted at cfg.outputDir.
func (s *server) resolveOutputPath(p string) string {
	p = filepath.ToSlash(p)
	if i := strings.Index(p, "output/"); i >= 0 {
		p = p[i+len("output/"):]
	}
	p = strings.TrimPrefix(p, "/")
	return filepath.Join(s.cfg.outputDir, filepath.FromSlash(p))
}

// ---------------------------------------------------------------------------
// Query parameter → RenderRequest mapping
// ---------------------------------------------------------------------------

// buildRenderRequest converts the incoming query params into a zrenderer
// RenderRequest body and returns the expected output file extension.
//
// Still-vs-animation rule (relies on zrenderer's frame default of -1 = all frames):
//   - frame present                 → still image (that frame)
//   - frame absent, action present  → animation (APNG of all frames)
//   - frame absent, action absent   → still image (frame 0)
func buildRenderRequest(q url.Values) (map[string]any, string, error) {
	jobs := splitCSV(q.Get("job"))
	if len(jobs) == 0 {
		return nil, "", errors.New("missing required 'job' parameter, e.g. /image?job=1002")
	}

	body := map[string]any{"job": jobs}

	// Integer params passed straight through.
	for _, name := range []string{"action", "frame", "head", "outfit", "garment", "weapon", "shield", "bodyPalette", "headPalette"} {
		if q.Has(name) {
			n, err := parseInt(name, q.Get(name))
			if err != nil {
				return nil, "", err
			}
			body[name] = n
		}
	}

	// headgear: comma-separated ints (up to 3).
	if q.Has("headgear") {
		var ids []int
		for _, part := range splitCSV(q.Get("headgear")) {
			n, err := parseInt("headgear", part)
			if err != nil {
				return nil, "", err
			}
			ids = append(ids, n)
		}
		body["headgear"] = ids
	}

	// Enum-ish params: accept friendly names or raw ints.
	// Enum integer values below match zrenderer's config.d toInt() mappings.
	if q.Has("gender") {
		n, err := parseEnum("gender", q.Get("gender"), map[string]int{"female": 0, "male": 1}, []int{0, 1})
		if err != nil {
			return nil, "", err
		}
		body["gender"] = n
	}
	if q.Has("headdir") {
		n, err := parseEnum("headdir", q.Get("headdir"),
			map[string]int{"straight": 0, "right": 1, "left": 2, "all": 3}, []int{0, 1, 2, 3})
		if err != nil {
			return nil, "", err
		}
		body["headdir"] = n
	}
	if q.Has("madogearType") {
		n, err := parseEnum("madogearType", q.Get("madogearType"),
			map[string]int{"robot": 0, "unused": 1, "suit": 2}, []int{0, 1, 2})
		if err != nil {
			return nil, "", err
		}
		body["madogearType"] = n
	}

	if q.Has("enableShadow") {
		b, err := parseBool("enableShadow", q.Get("enableShadow"))
		if err != nil {
			return nil, "", err
		}
		body["enableShadow"] = b
	}
	if q.Has("canvas") {
		body["canvas"] = q.Get("canvas")
	}

	// outputFormat decides the file extension we cache/serve.
	ext := ".png"
	if q.Has("outputFormat") {
		n, err := parseEnum("outputFormat", q.Get("outputFormat"),
			map[string]int{"png": 0, "zip": 1}, []int{0, 1})
		if err != nil {
			return nil, "", err
		}
		body["outputFormat"] = n
		if n == 1 {
			ext = ".zip"
		}
	}

	// Apply the still-vs-animation rule. `frame` is set explicitly (rather than
	// relying on zrenderer's omitted-field default) so the behavior is guaranteed:
	//   - action present → frame -1 (all frames → animated APNG)
	//   - otherwise      → frame 0  (single still image)
	if !q.Has("frame") {
		if q.Has("action") {
			body["frame"] = -1
		} else {
			body["frame"] = 0
		}
	}

	return body, ext, nil
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

// cacheKey is a stable hash of the (canonicalized) query parameters: keys and
// repeated values sorted, empty values dropped. Identical query params — in any
// order — map to the same cache entry.
func cacheKey(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var sb strings.Builder
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			if v == "" {
				continue
			}
			sb.WriteString(k)
			sb.WriteByte('=')
			sb.WriteString(v)
			sb.WriteByte('\n')
		}
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:])
}

// ---------------------------------------------------------------------------
// Access token loader
// ---------------------------------------------------------------------------

var tokenPattern = regexp.MustCompile(`^[0-9a-z]{32}$`)

// tokenLoader lazily reads the access token that zrenderer auto-generates into
// the shared secrets file. The file may not exist yet on first boot, so reads
// are retried for a short window.
type tokenLoader struct {
	file     string
	override string

	mu    sync.Mutex
	token string
}

func (t *tokenLoader) get() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.token != "" {
		return t.token, nil
	}
	if t.override != "" {
		t.token = t.override
		return t.token, nil
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		tok, err := readToken(t.file)
		if err == nil {
			t.token = tok
			log.Printf("loaded access token from %s", t.file)
			return tok, nil
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("reading token from %s: %w", t.file, err)
		}
		time.Sleep(time.Second)
	}
}

func (t *tokenLoader) invalidate() {
	t.mu.Lock()
	t.token = ""
	t.mu.Unlock()
}

// readToken parses zrenderer's accesstokens.conf:
//
//	<lastId>
//	<id>,<token>,<description>,<capabilities...>
//
// The token is a 32-char [0-9a-z] field. We return the first one we find.
func readToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		for _, field := range strings.Split(strings.TrimSpace(line), ",") {
			if tokenPattern.MatchString(field) {
				return field, nil
			}
		}
	}
	return "", errors.New("no access token found in file yet")
}

// ---------------------------------------------------------------------------
// Single-flight (stdlib-only): dedup concurrent identical renders
// ---------------------------------------------------------------------------

type flightGroup struct {
	mu sync.Mutex
	m  map[string]*flightCall
}

type flightCall struct {
	wg  sync.WaitGroup
	val struct{}
	err error
}

func newFlightGroup() *flightGroup { return &flightGroup{m: make(map[string]*flightCall)} }

func (g *flightGroup) Do(key string, fn func() (struct{}, error)) (struct{}, error) {
	g.mu.Lock()
	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := &flightCall{}
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()
	c.wg.Done()

	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()
	return c.val, c.err
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

func splitCSV(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseInt(name, s string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, fmt.Errorf("'%s' must be an integer, got %q", name, s)
	}
	return n, nil
}

func parseBool(name, s string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	}
	return false, fmt.Errorf("'%s' must be a boolean (true/false), got %q", name, s)
}

// parseEnum accepts either a friendly name (from names) or a raw allowed int.
func parseEnum(name, s string, names map[string]int, allowed []int) (int, error) {
	s = strings.TrimSpace(s)
	if v, ok := names[strings.ToLower(s)]; ok {
		return v, nil
	}
	if n, err := strconv.Atoi(s); err == nil {
		for _, a := range allowed {
			if n == a {
				return n, nil
			}
		}
	}
	keys := make([]string, 0, len(names))
	for k := range names {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return 0, fmt.Errorf("'%s' must be one of %v or %v, got %q", name, keys, allowed, s)
}

func contentTypeForExt(ext string) string {
	switch ext {
	case ".zip":
		return "application/zip"
	default:
		return "image/png" // covers PNG and APNG
	}
}

func fileExists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir()
}

// copyToCache copies src → dst atomically (temp file + rename).
func copyToCache(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("opening render output %q: %w", src, err)
	}
	defer in.Close()

	tmp, err := os.CreateTemp(filepath.Dir(dst), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename

	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, dst)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s%s → %d (%s)", r.Method, r.URL.Path, queryString(r.URL.RawQuery), sw.status, time.Since(start).Round(time.Millisecond))
	})
}

func queryString(raw string) string {
	if raw == "" {
		return ""
	}
	return "?" + raw
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}
