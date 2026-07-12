// ragassets-gateway is a fast, public HTTP layer that renders Ragnarok Online
// sprites in-process (see internal/render, a native Go reimplementation of
// zhad3/zrenderer) and serves them as PNG/APNG. It maps query parameters to an
// engine.Request, renders, and streams the bytes with long-lived immutable cache
// headers (plus an ETag derived from the query) so the browser/CDN does the
// caching — the server itself keeps no on-disk cache.
//
// Concurrent identical requests are coalesced by a single-flight group so a burst
// of the same query renders only once. /gif renders the same way and converts the
// PNG/APNG to a GIF in-process (see gif.go); /icons serves static images that
// extract-grf.mjs pulled out of the client GRF, and /effects serves the
// "effect-only" costume bundles (.str world effects) it extracts for the map
// simulator.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ragassets/gateway/internal/effect"
	"github.com/ragassets/gateway/internal/render/engine"
	"github.com/ragassets/gateway/internal/render/resolve"
)

// ---------------------------------------------------------------------------
// Configuration (from environment, with sane defaults for docker-compose)
// ---------------------------------------------------------------------------

type config struct {
	resourceDir string // extracted GRF assets (contains data/)
	iconsDir    string
	effectsDir  string
	mapsDir     string
	bgmDir      string
	soundsDir   string
	port        string
}

func loadConfig() config {
	return config{
		resourceDir: env("RESOURCE_DIR", "/resources"),
		iconsDir:    env("ICONS_DIR", "/icons"),
		effectsDir:  env("EFFECTS_DIR", "/effects"),
		mapsDir:     env("MAPS_DIR", "/maps"),
		bgmDir:      env("BGM_DIR", "/bgm"),
		soundsDir:   env("SOUNDS_DIR", "/sounds"),
		port:        env("GATEWAY_PORT", "8080"),
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
	eng    *engine.Engine
	flight *flightGroup
	estore *effect.Store // raw effect assets under RESOURCE_DIR/data/texture/effect

	// Precomputed strong validators for the two embedded lookup tables (their
	// bytes are fixed at build time, so the ETag is computed once).
	skillMapETag string
	effTableETag string
}

func main() {
	cfg := loadConfig()
	if fi, err := os.Stat(filepath.Join(cfg.resourceDir, "data")); err != nil || !fi.IsDir() {
		log.Fatalf("resource dir %q has no data/ subdir — run extract-grf.mjs (RESOURCE_DIR=%s)", cfg.resourceDir, cfg.resourceDir)
	}

	s := &server{
		cfg:          cfg,
		eng:          engine.New(cfg.resourceDir, resolve.DefaultTables()),
		flight:       newFlightGroup(),
		estore:       effect.NewStore(cfg.resourceDir),
		skillMapETag: hashBytes(effect.SkillMapJSON),
		effTableETag: hashBytes(effect.EffectTableJSON),
	}

	if fi, err := os.Stat(cfg.iconsDir); err != nil || !fi.IsDir() {
		log.Printf("icons: %s not found — /icons/* will return 404 (run extract-grf.mjs --icons)", cfg.iconsDir)
	} else {
		log.Printf("icons: serving %s at /icons/{type}/{id}.png", cfg.iconsDir)
	}

	if fi, err := os.Stat(cfg.effectsDir); err != nil || !fi.IsDir() {
		log.Printf("effects: %s not found — /effects/* will return 404 (run extract-grf.mjs --effects)", cfg.effectsDir)
	} else {
		log.Printf("effects: serving %s at /effects/{key}/{effect.json,tex_N.png}, /effects/sprites/{key}/{sprite.json,N.png} and /effects/index.json", cfg.effectsDir)
	}

	if fi, err := os.Stat(filepath.Join(cfg.resourceDir, "data", "texture", "effect")); err != nil || !fi.IsDir() {
		log.Printf("effect assets: %s/data/texture/effect not found — /effect/str and /effect/texture will 404 (extract data/texture/effect into RESOURCE_DIR); /effect/skill-map and /effect/table still serve", cfg.resourceDir)
	} else {
		log.Printf("effect assets: serving /effect/str, /effect/texture, /effect/skill-map, /effect/table")
	}

	if fi, err := os.Stat(cfg.mapsDir); err != nil || !fi.IsDir() {
		log.Printf("maps: %s not found — /maps/* will return 404 (run extract-grf.mjs --maps)", cfg.mapsDir)
	} else {
		log.Printf("maps: serving %s at /maps/{map}/{manifest.json,<map>.gat|gnd|rsw}, shared /maps/_{t,m,w,u}/<hash>.* and /maps/index.json", cfg.mapsDir)
	}

	if fi, err := os.Stat(cfg.bgmDir); err != nil || !fi.IsDir() {
		log.Printf("bgm: %s not found — /bgm/* will return 404 (run extract-grf.mjs --bgm)", cfg.bgmDir)
	} else {
		log.Printf("bgm: serving %s at /bgm/{track}.mp3 and /bgm/index.json", cfg.bgmDir)
	}

	if fi, err := os.Stat(cfg.soundsDir); err != nil || !fi.IsDir() {
		log.Printf("sounds: %s not found — /effect/sound will return 404 (run extract-grf.mjs --sounds)", cfg.soundsDir)
	} else {
		log.Printf("sounds: serving %s at /effect/sound?file=<name> and /effect/sound/index.json", cfg.soundsDir)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/image", s.handleImage)
	mux.HandleFunc("/gif", s.handleGif)
	mux.HandleFunc("/icons/", s.handleIcon)
	mux.HandleFunc("/effects/", s.handleEffect)
	mux.HandleFunc("/effect/", s.handleEffectAsset)
	mux.HandleFunc("/maps/", s.handleMap)
	mux.HandleFunc("/bgm/", s.handleBgm)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok")
	})
	mux.HandleFunc("/", s.handleRoot)

	addr := ":" + cfg.port
	log.Printf("ragassets-gateway listening on %s (resources: %s)", addr, cfg.resourceDir)
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
	io.WriteString(w, "ragassets-gateway — renders and serves Ragnarok Online sprites, icons, maps, and BGM.\n\n"+
		"Try: /image?job=1002            (still image)\n"+
		"     /image?job=1002&action=0   (animation, APNG)\n"+
		"     /gif?job=1002&action=0     (same, as an animated GIF)\n"+
		"     /icons/item/501.png        (static item/collection/skill/job/ui images)\n"+
		"     /effects/index.json        (effect-only costume catalogue)\n"+
		"     /effects/c_spot_light/effect.json   (one effect's .str animation + textures)\n"+
		"     /effects/sprites/torch_01/sprite.json  (one sprite map-effect's per-frame img/delay/offset)\n"+
		"     /effect/str?file=stormgust  (a skill effect's parsed .str keyframe animation, as JSON)\n"+
		"     /effect/texture?file=stormgust/storm_ball  (one .str layer texture, colorkeyed PNG)\n"+
		"     /effect/sound?file=effect/ef_portal  (one sound effect, browser-playable WAV)\n"+
		"     /effect/sound/index.json   (names present in the extracted sound tree)\n"+
		"     /effect/skill-map          (skillId → effectId(s) lookup, ported from roBrowser)\n"+
		"     /effect/table              (effectId → effect parts lookup, ported from roBrowser)\n"+
		"     /maps/index.json           (world-map catalogue for the map simulator)\n"+
		"     /maps/prontera/manifest.json  (one map's geometry + shared asset manifest)\n"+
		"     /bgm/index.json            (per-map background-music catalogue)\n"+
		"     /bgm/210.mp3               (one background-music track)\n\n"+
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

	req, ext, err := buildRequest(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	etag := etagFor(q)
	contentType := contentTypeForExt(ext)

	// The ETag is a pure function of the (immutable) query, so a revalidating
	// client that already holds these bytes can be answered without rendering.
	if ifNoneMatch(r, etag) {
		notModified(w, etag)
		return
	}

	// Render once even under a burst of identical requests (single-flight); the
	// bytes are served directly and cached only by the browser/CDN.
	data, err := s.flight.Do(etag+ext, func() ([]byte, error) {
		return s.renderImage(req, ext)
	})
	if err != nil {
		log.Printf("render failed for %s: %v", r.URL.RawQuery, err)
		http.Error(w, "render failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	s.serveBytes(w, r, data, etag, contentType)
}

// handleGif renders the same thing /image would, then converts the PNG/APNG to a
// GIF (cached separately, under the same query hash + ".gif"). It accepts every
// /image parameter; only outputFormat=zip is rejected, since the response is a
// single GIF image.
func (s *server) handleGif(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query()

	req, ext, err := buildRequest(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if ext == ".zip" {
		http.Error(w, "outputFormat=zip is not supported on /gif (it returns a single GIF image)", http.StatusBadRequest)
		return
	}

	// A distinct ETag so /gif never collides with /image's validators for the
	// same query (their bytes differ).
	etag := etagFor(q) + "-gif"

	if ifNoneMatch(r, etag) {
		notModified(w, etag)
		return
	}

	data, err := s.flight.Do(etag, func() ([]byte, error) {
		png, err := s.renderImage(req, ".png")
		if err != nil {
			return nil, err
		}
		return apngBytesToGIF(png)
	})
	if err != nil {
		log.Printf("gif render/convert failed for %s: %v", r.URL.RawQuery, err)
		http.Error(w, "render failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	s.serveBytes(w, r, data, etag, "image/gif")
}

// serveBytes streams freshly rendered bytes with immutable cache headers and
// conditional-request support (ETag / 304 / ranges, via http.ServeContent).
func (s *server) serveBytes(w http.ResponseWriter, r *http.Request, data []byte, etag, contentType string) {
	s.serveReader(w, r, bytes.NewReader(data), time.Time{}, etag, contentType)
}

// serveReader is the shared response path for renders (a bytes.Reader) and icons
// (an open *os.File). It sets the asset cache/CORS headers and lets
// http.ServeContent handle If-None-Match against our ETag plus range requests.
func (s *server) serveReader(w http.ResponseWriter, r *http.Request, content io.ReadSeeker, modTime time.Time, etag, contentType string) {
	w.Header().Set("Content-Type", contentType)
	setAssetHeaders(w, etag)
	http.ServeContent(w, r, "", modTime, content)
}

// setAssetHeaders applies the long-lived immutable cache policy and the wildcard
// CORS header shared by every served asset (renders and icons). The bytes are
// public, read-only, and content-addressed by their ETag, so any origin may read
// them and a simple GET needs no preflight.
func setAssetHeaders(w http.ResponseWriter, etag string) {
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Etag", `"`+etag+`"`)
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

// fileETag derives a strong validator for a static file from its mtime+size. The
// /icons and /effects handlers re-extract files in place, so this changes exactly
// when the bytes do (renders use their query hash instead).
func fileETag(fi os.FileInfo) string {
	return fmt.Sprintf("%x-%x", fi.ModTime().UnixNano(), fi.Size())
}

// notModified answers a conditional request whose validator already matches: it
// sends the cache/CORS headers (so intermediaries keep caching) and a bare 304.
func notModified(w http.ResponseWriter, etag string) {
	setAssetHeaders(w, etag)
	w.WriteHeader(http.StatusNotModified)
}

// ifNoneMatch reports whether the request's If-None-Match header already lists
// our (strong) ETag — i.e. the client holds these exact bytes. Handles a
// comma-separated list, the "*" wildcard, and a weak "W/" prefix.
func ifNoneMatch(r *http.Request, etag string) bool {
	inm := r.Header.Get("If-None-Match")
	if inm == "" {
		return false
	}
	quoted := `"` + etag + `"`
	for _, part := range strings.Split(inm, ",") {
		p := strings.TrimSpace(part)
		if p == "*" || p == quoted || p == "W/"+quoted {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// /icons handler — static item/collection/skill/job icons extracted from the
// client GRF by extract-grf.mjs --icons. Served as-is; no sprite rendering.
// ---------------------------------------------------------------------------

// The kinds and the filenames mirror what extract-grf.mjs --icons produces —
// numeric-id PNGs for item/collection/skill/job/status and client-basename PNGs
// for ui (character-creation elements). Keep in sync with extractIcons() there.
var iconKinds = map[string]bool{"item": true, "collection": true, "skill": true, "job": true, "status": true, "ui": true}
var iconFilePattern = regexp.MustCompile(`^[a-z0-9_]+\.png$`)

// handleIcon serves /icons/{type}/{name}.png from the icons dir. The kind
// whitelist plus the lowercase-word filename pattern (no dots, no slashes)
// make path traversal structurally impossible; anything else is a 404.
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
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r) // unknown id, or icons not extracted yet
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}

	s.serveReader(w, r, f, fi.ModTime(), fileETag(fi), "image/png")
}

// ---------------------------------------------------------------------------
// /effects handler — the "effect-only" costumes (auras, falling petals,
// spotlights) the sprite renderer can't draw, served as the bundles
// extract-grf.mjs --effects produces for the latamvisuais map simulator:
//
//   /effects/index.json              the costume catalogue ({items:[{id,name,slots,effect}]})
//   /effects/{key}/effect.json       the parsed .str keyframe animation
//   /effects/{key}/tex_N.png         that effect's layer textures
//   /effects/sprites/{key}/sprite.json   a sprite map-effect's per-frame play list ({frames:[{img,delay,offset}]})
//   /effects/sprites/{key}/N.png         that sprite effect's composited frames
//
// `key` is a slug ([a-z0-9_]); the strict key + filename patterns (no dots, no
// slashes) make path traversal structurally impossible. ("sprites" is a reserved
// subtree, never a costume key, so the prefix check below can't shadow one.)
// ---------------------------------------------------------------------------

var effectKeyPattern = regexp.MustCompile(`^[a-z0-9_]+$`)
var effectFilePattern = regexp.MustCompile(`^(effect\.json|tex_[0-9]+\.png)$`)
var spriteFilePattern = regexp.MustCompile(`^(sprite\.json|[0-9]+\.png)$`)

func (s *server) handleEffect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/effects/")
	rel := rest // the catalogue, served as-is
	switch {
	case rest == "index.json":
		// served as-is
	case strings.HasPrefix(rest, "sprites/"):
		parts := strings.Split(rest, "/") // sprites/{key}/{file}
		if len(parts) != 3 || !effectKeyPattern.MatchString(parts[1]) || !spriteFilePattern.MatchString(parts[2]) {
			http.NotFound(w, r)
			return
		}
		rel = filepath.Join("sprites", parts[1], parts[2])
	default:
		parts := strings.Split(rest, "/")
		if len(parts) != 2 || !effectKeyPattern.MatchString(parts[0]) || !effectFilePattern.MatchString(parts[1]) {
			http.NotFound(w, r)
			return
		}
		rel = filepath.Join(parts[0], parts[1])
	}
	contentType := "image/png"
	if strings.HasSuffix(rel, ".json") {
		contentType = "application/json"
	}

	f, err := os.Open(filepath.Join(s.cfg.effectsDir, rel))
	if err != nil {
		http.NotFound(w, r) // unknown effect/file, or effects not extracted yet
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}

	s.serveReader(w, r, f, fi.ModTime(), fileETag(fi), contentType)
}

// ---------------------------------------------------------------------------
// /effect handler — skill/world effect data for the .rrf replay viewer, which
// renders effects itself in WebGL (a port of roBrowser's StrEffect). ragassets
// is a data + texture server here, not a renderer, so nothing is baked to a flat
// image (that would destroy the per-layer additive blending the client needs):
//
//   /effect/str?file=<name>       a parsed .str keyframe animation, as JSON
//                                 (raw D3DBLEND src/dest alpha kept verbatim)
//   /effect/texture?file=<name>   one .str layer texture as a colorkeyed PNG
//                                 (magenta #FF00FF → alpha; .bmp/.tga source)
//   /effect/sound?file=<name>     one sound effect as browser-playable WAV audio
//                                 (data/wav/<name>.wav; e.g. effect/ef_portal)
//   /effect/sound/index.json      the names present in the extracted sound tree
//   /effect/skill-map             skillId → { effectId?, hitEffectId?, groundEffectId?, wav? }
//   /effect/table                 effectId → [ { type, file, min, wav, rand, ... } ]
//
// str/texture parse on demand from RESOURCE_DIR/data/texture/effect (like /image
// renders from the sprite tree); <name> is relative to that dir, may omit the
// .str / .bmp / .tga suffix, and is resolved case-insensitively. skill-map/table
// are embedded JSON ported verbatim from roBrowser (see internal/effect), plus a
// skill-map `wav` array resolved and verified at generation time (see
// tools/gen-effect-tables.mjs resolveSkillWav) — every name in it is guaranteed
// to exist in the extracted sound tree, so it needs no fallback logic on the
// client. sound serves that static tree (SOUNDS_DIR, written by extract-grf.mjs
// --sounds), the audio counterpart of both wav fields.
// ---------------------------------------------------------------------------

func (s *server) handleEffectAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	switch strings.TrimPrefix(r.URL.Path, "/effect/") {
	case "str":
		s.handleEffectStr(w, r)
	case "texture":
		s.handleEffectTexture(w, r)
	case "sound":
		s.handleEffectSound(w, r)
	case "sound/index.json":
		s.handleEffectSoundIndex(w, r)
	case "skill-map":
		s.serveEmbeddedJSON(w, r, effect.SkillMapJSON, s.skillMapETag)
	case "table":
		s.serveEmbeddedJSON(w, r, effect.EffectTableJSON, s.effTableETag)
	default:
		http.NotFound(w, r)
	}
}

// handleEffectStr parses data/texture/effect/<file>.str and returns it as JSON.
// The parse is deterministic in the file bytes, so (like /image) the query hash
// is a valid content ETag and identical requests render only once (single-flight).
func (s *server) handleEffectStr(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}
	etag := etagFor(r.URL.Query()) + "-effstr"
	if ifNoneMatch(r, etag) {
		notModified(w, etag)
		return
	}

	data, ok, err := s.estore.Read(file, []string{".str"})
	if err != nil {
		log.Printf("effect str read failed for %q: %v", file, err)
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.NotFound(w, r)
		return
	}

	out, err := s.flight.Do(etag, func() ([]byte, error) {
		str, err := effect.ParseStr(data)
		if err != nil {
			return nil, err
		}
		return json.Marshal(str)
	})
	if err != nil {
		log.Printf("effect str parse failed for %q: %v", file, err)
		http.Error(w, "parse failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.serveBytes(w, r, out, etag, "application/json")
}

// handleEffectTexture converts a data/texture/effect/ BMP or TGA to a colorkeyed
// RGBA PNG. Either extension resolves when the caller omits it.
func (s *server) handleEffectTexture(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}
	etag := etagFor(r.URL.Query()) + "-efftex"
	if ifNoneMatch(r, etag) {
		notModified(w, etag)
		return
	}

	p, ok := s.estore.ResolveEffect(file, []string{".bmp", ".tga"})
	if !ok {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(p)
	if err != nil {
		log.Printf("effect texture read failed for %q: %v", file, err)
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}

	out, err := s.flight.Do(etag, func() ([]byte, error) {
		return effect.TextureToPNG(data, p)
	})
	if err != nil {
		log.Printf("effect texture decode failed for %q: %v", file, err)
		http.Error(w, "decode failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.serveBytes(w, r, out, etag, "image/png")
}

// handleEffectSound serves one sound effect from the extracted data/wav/ tree
// (SOUNDS_DIR) as browser-playable WAV. `file` is a name relative to data/wav/
// without the .wav extension — the same token the effect table's `wav` field
// carries (e.g. "effect/ef_portal", the bare "_heal_effect"). A name the GRF
// never shipped 404s, which the client treats as "no sound for this effect" and
// silently skips — so a wrong sound is never served in place of a missing one.
func (s *server) handleEffectSound(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}

	p, ok := s.resolveSound(file)
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}

	// extract-grf.mjs --sounds normalizes every output to PCM WAV (transcoding the
	// few ADPCM sources), so the whole tree is a single Content-Type.
	s.serveReader(w, r, f, fi.ModTime(), fileETag(fi), "audio/wav")
}

// handleEffectSoundIndex serves the manifest of sound names present in the
// extracted tree, for coverage preflighting (a sibling of /bgm/index.json).
func (s *server) handleEffectSoundIndex(w http.ResponseWriter, r *http.Request) {
	f, err := os.Open(filepath.Join(s.cfg.soundsDir, "index.json"))
	if err != nil {
		http.NotFound(w, r) // sounds not extracted yet
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}
	s.serveReader(w, r, f, fi.ModTime(), fileETag(fi), "application/json")
}

// resolveSound maps a requested wav name to a file in the extracted sound tree.
// It appends .wav, folds case (the tree is lowercased; the table's names are
// lowercase ASCII), and — on a miss for a name carrying EUC-KR bytes rendered as
// latin1 — retries under the decoded Hangul path (see effect.EUCKRReinterpret),
// which is how the client's Korean-named effect sounds match. It never strips or
// adds the "effect/" path prefix: a name that points at a file this client's GRF
// didn't ship stays a 404, exactly as it would in the real client.
func (s *server) resolveSound(file string) (string, bool) {
	file = strings.ReplaceAll(file, "\\", "/")
	// The table never includes the extension, but tolerate a stray .wav.
	if len(file) >= 4 && strings.EqualFold(file[len(file)-4:], ".wav") {
		file = file[:len(file)-4]
	}
	if p, ok := s.soundPath(file); ok {
		return p, true
	}
	if k, ok := effect.EUCKRReinterpret(file); ok {
		if p, ok := s.soundPath(k); ok {
			return p, true
		}
	}
	return "", false
}

// soundPath folds a single candidate name to an on-disk path under SOUNDS_DIR,
// or reports false if it's empty, escapes the tree, or names a directory.
// path.Clean collapses every "."/".." segment, so a cleaned result that is bare
// ".."/"." or still climbs ("../…") is the only way out of the tree — the same
// traversal guard the effect Store uses (see internal/effect/store.go effectRel).
func (s *server) soundPath(name string) (string, bool) {
	rel := strings.ToLower(strings.TrimSpace(name))
	if rel == "" || strings.HasPrefix(rel, "/") {
		return "", false
	}
	cleaned := path.Clean(rel)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false
	}
	p := filepath.Join(s.cfg.soundsDir, filepath.FromSlash(cleaned)+".wav")
	if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
		return p, true
	}
	return "", false
}

// serveEmbeddedJSON serves a fixed embedded JSON blob with the shared immutable
// cache/CORS headers and conditional-request support against its precomputed ETag.
func (s *server) serveEmbeddedJSON(w http.ResponseWriter, r *http.Request, data []byte, etag string) {
	if ifNoneMatch(r, etag) {
		notModified(w, etag)
		return
	}
	s.serveBytes(w, r, data, etag, "application/json")
}

// hashBytes is the strong validator for a fixed byte blob (the embedded tables).
func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ---------------------------------------------------------------------------
// /maps handler — world-map bundles for the latamvisuais 3D map simulator,
// produced by extract-grf.mjs --maps. Each map dir holds its raw geometry plus a
// manifest.json that resolves resource names to shared, content-addressed blobs:
//
//   /maps/index.json             { maps: [...] } — every extracted map name
//   /maps/{map}/manifest.json    resolves model/texture/water/UI names → blob paths
//   /maps/{map}/{map}.gat|gnd|rsw  raw geometry (browser-parsed)
//   /maps/_t/{hash}.png          a shared texture        (referenced as ../_t/...)
//   /maps/_m/{hash}.rsm          a shared model
//   /maps/_w/{hash}.jpg          a shared water frame
//   /maps/_u/{hash}.png          a shared UI image (grid / cursor frame)
//
// The strict per-segment patterns (lowercase map slug; 16-hex blob hashes; a
// fixed geometry/file whitelist) make path traversal structurally impossible.
// ---------------------------------------------------------------------------

var mapNamePattern = regexp.MustCompile(`^[a-z0-9_@-]+$`)
var mapBlobPattern = regexp.MustCompile(`^[0-9a-f]{16}\.(png|rsm|jpg)$`)

// blobDirExt is the extension each shared store is allowed to serve, so e.g.
// /maps/_t/<hash>.rsm (wrong store) is a 404 rather than a content-type mismatch.
var blobDirExt = map[string]string{"_t": "png", "_m": "rsm", "_w": "jpg", "_u": "png"}

func (s *server) handleMap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/maps/")
	rel, ok := resolveMapPath(rest)
	if !ok {
		http.NotFound(w, r)
		return
	}

	f, err := os.Open(filepath.Join(s.cfg.mapsDir, rel))
	if err != nil {
		http.NotFound(w, r) // unknown map/blob, or maps not extracted yet
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}

	s.serveReader(w, r, f, fi.ModTime(), fileETag(fi), mapContentType(rel))
}

// resolveMapPath validates the path under /maps/ and returns the (slash-cleaned)
// file path relative to the maps dir. It accepts exactly: index.json, a shared
// blob (_t/_m/_w/_u + 16-hex hash with the store's extension), and a per-map
// manifest.json or <map>.gat|gnd|rsw. Anything else is rejected.
func resolveMapPath(rest string) (string, bool) {
	if rest == "index.json" {
		return "index.json", true
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		return "", false
	}
	dir, file := parts[0], parts[1]

	if ext, ok := blobDirExt[dir]; ok { // shared content-addressed blob
		if !mapBlobPattern.MatchString(file) || !strings.HasSuffix(file, "."+ext) {
			return "", false
		}
		return dir + "/" + file, true
	}

	if !mapNamePattern.MatchString(dir) { // per-map directory
		return "", false
	}
	if file == "manifest.json" ||
		file == dir+".gat" || file == dir+".gnd" || file == dir+".rsw" {
		return dir + "/" + file, true
	}
	return "", false
}

func mapContentType(rel string) string {
	switch {
	case strings.HasSuffix(rel, ".json"):
		return "application/json"
	case strings.HasSuffix(rel, ".png"):
		return "image/png"
	case strings.HasSuffix(rel, ".jpg"):
		return "image/jpeg"
	default: // .gat/.gnd/.rsw geometry, .rsm models — opaque binaries
		return "application/octet-stream"
	}
}

// ---------------------------------------------------------------------------
// /bgm handler — per-map background music produced by extract-grf.mjs --bgm.
//
//	/bgm/index.json   { maps: { "<map>": "<track>.mp3", … } } — map → its track
//	/bgm/{track}.mp3  one background-music track (tracks are shared across maps)
//
// Tracks are numerically named in the client, so the basename whitelist below
// makes path traversal structurally impossible.
// ---------------------------------------------------------------------------

var bgmTrackPattern = regexp.MustCompile(`^[0-9a-z_-]+\.mp3$`)

func (s *server) handleBgm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/bgm/")
	if rest != "index.json" && !bgmTrackPattern.MatchString(rest) {
		http.NotFound(w, r)
		return
	}

	f, err := os.Open(filepath.Join(s.cfg.bgmDir, rest))
	if err != nil {
		http.NotFound(w, r) // unknown track, or bgm not extracted yet
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}

	ct := "audio/mpeg"
	if rest == "index.json" {
		ct = "application/json"
	}
	s.serveReader(w, r, f, fi.ModTime(), fileETag(fi), ct)
}

// ---------------------------------------------------------------------------
// ETag
// ---------------------------------------------------------------------------

// etagFor is a stable hash of the (canonicalized) query parameters: keys and
// repeated values sorted, empty values dropped. Identical query params — in any
// order — produce the same ETag. A render is fully determined by its query, so
// this doubles as a content validator for conditional requests.
func etagFor(q url.Values) string {
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
// Single-flight (stdlib-only): dedup concurrent identical renders
// ---------------------------------------------------------------------------

type flightGroup struct {
	mu sync.Mutex
	m  map[string]*flightCall
}

type flightCall struct {
	wg  sync.WaitGroup
	val []byte
	err error
}

func newFlightGroup() *flightGroup { return &flightGroup{m: make(map[string]*flightCall)} }

// Do runs fn for key, sharing the single in-flight result with every concurrent
// caller of the same key. The returned bytes must be treated as read-only (they
// are shared across callers).
func (g *flightGroup) Do(key string, fn func() ([]byte, error)) ([]byte, error) {
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
