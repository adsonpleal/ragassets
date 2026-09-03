//go:build js && wasm

// Command worker serves ragassets from a Cloudflare Worker, rendering in-place
// and reading assets from R2 through the colo edge cache.
//
// The renderer itself is unchanged and unaware: internal/render/engine is
// compiled to wasm as-is, and the golden tests pass pixel-identical under
// GOOS=js GOARCH=wasm. What differs is where bytes come from, which the
// Source/Existence seam in internal/render/resource already abstracts.
//
// Routing note: icons, illust, effects and raw are NOT handled here. They are
// served by Workers Static Assets, whose requests are free and unmetered — 69%
// of all traffic by measurement — and wrangler.jsonc lists only the paths that
// need the Worker under run_worker_first. That array must never become `true`:
// it would put every static asset behind the Worker request budget.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/syumai/workers"
	"github.com/syumai/workers/cloudflare/r2"

	"github.com/ragassets/gateway/internal/api"
	"github.com/ragassets/gateway/internal/effect"
	"github.com/ragassets/gateway/internal/render/encode"
	"github.com/ragassets/gateway/internal/render/engine"
	"github.com/ragassets/gateway/internal/render/gifenc"
	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/resource"
)

const (
	// bucketBinding must match the r2_buckets binding in wrangler.jsonc.
	bucketBinding = "ASSETS"
	// manifestKey is the existence manifest cmd/gen-manifest writes. It lives in
	// the bucket rather than being compiled in, so shipping new sprites is an
	// upload rather than a Worker redeploy.
	manifestKey = "manifest/exists.bin"
)

// deployEpoch is stamped in at build time (-ldflags "-X main.deployEpoch=..."),
// and forms part of every edge-cache key. Bumping it is how a deploy invalidates
// the cache: purge-by-URL is capped at 30 URLs a call and roughly 1,000 a day,
// and purge-by-prefix is Enterprise-only, so wholesale invalidation has to be
// built into the key rather than requested afterwards.
var deployEpoch = "dev"

// The runtime bindings are only reachable while a request is in flight, so
// everything is built on the first one and reused for the isolate's lifetime.
// That first request also pays for the manifest fetch — one R2 read of 1.44 MiB
// per cold start.
var (
	initOnce sync.Once
	initErr  error

	// Two views of the same bucket, differing only in key prefix.
	//
	// dataStore serves the renderer, whose keys are relative to the tree's data/
	// directory ("sprite/<name>.spr"). objStore serves everything addressed by
	// its full key — maps/, bgm/, sounds/ — and backs the effect store, which
	// builds "data/texture/..." itself.
	dataStore *resource.R2Store
	objStore  *resource.R2Store
	exist     resource.Existence
	eng       *engine.Engine
	estore    *effect.ObjectStore
)

func setup() {
	bucket, err := r2.NewBucket(bucketBinding)
	if err != nil {
		initErr = fmt.Errorf("r2 binding %q: %w", bucketBinding, err)
		return
	}
	m, err := resource.LoadManifestFromR2(bucket, manifestKey)
	if err != nil {
		initErr = fmt.Errorf("load %s: %w", manifestKey, err)
		return
	}
	dataStore = resource.NewR2Store(bucket, deployEpoch, "data/")
	objStore = resource.NewR2Store(bucket, deployEpoch, "")
	exist = m
	// One long-lived Engine, so its parse caches survive across requests. The
	// per-render prefetch warms the colo cache in parallel; the engine's own
	// reads then land on that cache rather than on R2.
	eng = engine.NewWithSource(dataStore, exist, resolve.DefaultTables())
	// The effect store reads the same bucket through the same cache; only its
	// resolution differs (see internal/effect/store_r2.go).
	estore = effect.NewObjectStore(objStore.Get)
}

func main() {
	workers.Serve(http.HandlerFunc(route))
}

func route(w http.ResponseWriter, r *http.Request) {
	initOnce.Do(setup)
	if initErr != nil {
		http.Error(w, "worker not initialised: "+initErr.Error(), http.StatusInternalServerError)
		return
	}

	switch p := r.URL.Path; {
	case p == "/":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, api.RootHelp)
	case p == "/debug/r2":
		handleDebugR2(w)
	case p == "/healthz":
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok")
	case p == "/image":
		handleRender(w, r, false)
	case p == "/gif":
		handleRender(w, r, true)
	case p == "/effect/skill-map":
		serveBytes(w, r, effect.SkillMapJSON, "application/json", api.CacheImmutable)
	case p == "/effect/table":
		serveBytes(w, r, effect.EffectTableJSON, "application/json", api.CacheImmutable)
	case p == "/effect/str":
		handleEffectStr(w, r)
	case p == "/effect/texture":
		handleEffectTexture(w, r)
	case p == "/effect/sound":
		handleEffectSound(w, r)
	case p == "/effect/sound/index.json":
		serveObject(w, r, "sounds/index.json", api.CacheImmutable)
	case strings.HasPrefix(p, "/maps/"):
		serveObject(w, r, strings.TrimPrefix(p, "/"), api.CacheImmutable)
	case strings.HasPrefix(p, "/bgm/"):
		serveObject(w, r, strings.TrimPrefix(p, "/"), api.CacheImmutable)
	default:
		http.NotFound(w, r)
	}
}

// isolateID distinguishes one isolate's counters from another's. The counters
// are process-wide, so a sample taken across an isolate boundary is meaningless;
// this makes that visible instead of silently wrong.
var isolateID = fmt.Sprintf("%x", time.Now().UnixNano())

// handleDebugR2 reports cumulative read counters, so cache hit rate and R2
// operation counts can be measured by sampling before and after a batch of
// traffic. Counts only — nothing about what was read, or by whom.
func handleDebugR2(w http.ResponseWriter) {
	type payload struct {
		Isolate string         `json:"isolate"`
		Epoch   string         `json:"epoch"`
		Data    resource.Stats `json:"data"`
		Objects resource.Stats `json:"objects"`
	}
	out, err := json.Marshal(payload{
		Isolate: isolateID,
		Epoch:   deployEpoch,
		Data:    dataStore.Stats(),
		Objects: objStore.Stats(),
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	writeBody(w, out)
}

// handleRender serves /image and /gif, which differ only in the final encode.
func handleRender(w http.ResponseWriter, r *http.Request, asGIF bool) {
	q := r.URL.Query()
	req, ext, err := api.BuildRequest(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if ext != ".png" {
		// A frame archive (zip) is a different response shape; the server still
		// handles those and the Worker does not yet.
		http.Error(w, "frame archives are not implemented on the Worker yet", http.StatusNotImplemented)
		return
	}

	// The ETag comes from the query alone, so a conditional request is answered
	// before any asset is read — the cheapest possible hit. /gif must not share
	// /image's validator for the same query, hence the suffix.
	etag := api.ETagFor(q)
	if asGIF {
		etag += "-gif"
	}
	setAssetHeaders(w, etag, api.CacheImmutable)
	if ifNoneMatch(r, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	// Plan first, then fetch everything the plan names in one parallel batch.
	// Fetching lazily mid-render would serialise 7-41 round trips at 20-40 ms
	// each, against 4-8 ms of actual rendering.
	plan := eng.Plan(req)
	dataStore.Prefetch(plan.Keys, exist)

	res, err := eng.RenderPlanned(req, plan)
	if err != nil {
		http.Error(w, "render: "+err.Error(), http.StatusInternalServerError)
		return
	}
	out, err := encode.Animation(res.Frames, res.IntervalMs)
	if err != nil {
		http.Error(w, "encode: "+err.Error(), http.StatusInternalServerError)
		return
	}
	contentType := "image/png"
	if asGIF {
		if out, err = gifenc.FromAPNG(out); err != nil {
			http.Error(w, "gif: "+err.Error(), http.StatusInternalServerError)
			return
		}
		contentType = "image/gif"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
	writeBody(w, out)
}

// handleEffectStr parses one .str world/skill effect into JSON.
func handleEffectStr(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}
	etag := api.ETagFor(r.URL.Query()) + "-effstr"
	setAssetHeaders(w, etag, api.CacheImmutable)
	if ifNoneMatch(r, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	data, _, ok, err := estore.Read(file, []string{".str"})
	if err != nil || !ok {
		http.NotFound(w, r)
		return
	}
	parsed, err := effect.ParseStr(data)
	if err != nil {
		http.Error(w, "parse: "+err.Error(), http.StatusInternalServerError)
		return
	}
	out, err := json.Marshal(parsed)
	if err != nil {
		http.Error(w, "encode: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
	writeBody(w, out)
}

// handleEffectTexture decodes a BMP/TGA effect texture, colour-keys magenta to
// alpha and re-encodes it as PNG.
func handleEffectTexture(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}
	etag := api.ETagFor(r.URL.Query()) + "-efftex"
	setAssetHeaders(w, etag, api.CacheImmutable)
	if ifNoneMatch(r, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	data, name, ok, err := estore.Read(file, []string{".bmp", ".tga"})
	if err != nil || !ok {
		http.NotFound(w, r)
		return
	}
	// name carries the extension TextureToPNG decides BMP-vs-TGA from.
	out, err := effect.TextureToPNG(data, name)
	if err != nil {
		http.Error(w, "decode: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
	writeBody(w, out)
}

// handleEffectSound serves one WAV from the extracted data/wav tree. `file` is a
// name relative to it without the extension — the token the effect table's `wav`
// field carries. A name the client never shipped 404s, which callers treat as
// "no sound for this effect" and skip, so a wrong sound is never served in place
// of a missing one.
func handleEffectSound(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}
	key, ok := soundKey(file)
	if !ok {
		http.NotFound(w, r)
		return
	}
	b, err := objStore.Get(key)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveBytes(w, r, b, "audio/wav", api.CacheImmutable)
}

// soundKey folds a sound token to an object key under sounds/, rejecting any
// attempt to climb out of that subtree.
func soundKey(file string) (string, bool) {
	f := strings.ReplaceAll(file, "\\", "/")
	if f == "" || strings.HasPrefix(f, "/") {
		return "", false
	}
	if !strings.HasSuffix(strings.ToLower(f), ".wav") {
		f += ".wav"
	}
	clean := path.Clean(f)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return "sounds/" + clean, true
}

func ifNoneMatch(r *http.Request, etag string) bool {
	m := r.Header.Get("If-None-Match")
	return m != "" && strings.Contains(m, etag)
}

// rawJSBodyWriter is syumai/workers' escape hatch for handing the runtime a body
// it already has, instead of streaming one.
type rawJSBodyWriter interface{ WriteRawJSBody(js.Value) }

// writeBody sends a fully-formed response body.
//
// It does not use w.Write, which pipes the bytes through a Go io.Pipe into a
// Cloudflare FixedLengthStream in 16,640-byte chunks. That writer awaits the
// stream's `ready` once before its loop and not per chunk, so a body large enough
// to need many chunks overruns the stream's backpressure queue and the Worker
// throws — observed as a hard 500 on /effect/table (171,283 bytes, 11 chunks)
// while /effect/skill-map (30,352 bytes, 2 chunks) was fine.
//
// Every response here is already fully in memory — a finished render, or an
// object read whole from R2 — so there is nothing to stream. Handing the runtime
// a Uint8Array skips the pipe, the chunking and the extra goroutine entirely.
func writeBody(w http.ResponseWriter, body []byte) {
	if rw, ok := w.(rawJSBodyWriter); ok {
		buf := js.Global().Get("Uint8Array").New(len(body))
		js.CopyBytesToJS(buf, body)
		rw.WriteRawJSBody(buf)
		return
	}
	w.Write(body)
}

// serveObject streams one R2 object straight through, for the stores that are
// plain key-to-bytes: maps and bgm.
//
// It does not consult the manifest. That covers only the renderer's tree
// (data/{sprite,palette,imf}), so a miss here would not be authoritative — R2
// itself is the authority for these prefixes.
func serveObject(w http.ResponseWriter, r *http.Request, key, cacheControl string) {
	b, err := objStore.Get(key)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveBytes(w, r, b, contentTypeFor(key), cacheControl)
}

func serveBytes(w http.ResponseWriter, r *http.Request, body []byte, contentType, cacheControl string) {
	etag := api.ETagForBytes(body)
	setAssetHeaders(w, etag, cacheControl)
	w.Header().Set("Content-Type", contentType)
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	writeBody(w, body)
}

// contentETag validates static bytes by their content. The server derives these
// from mtime+size, which R2 has no equivalent of; hashing the bytes is stable
// across re-uploads of identical content, so clients revalidate once at cutover
// and then stop.
func contentETag(b []byte) string {
	return api.ETagForBytes(b)
}

// setAssetHeaders mirrors the server's: the cache policy, a quoted ETag, and the
// wildcard CORS header every asset carries. The bytes are public and read-only,
// so any origin may read them and a simple GET needs no preflight.
func setAssetHeaders(w http.ResponseWriter, etag, cacheControl string) {
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("Etag", `"`+etag+`"`)
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

func contentTypeFor(key string) string {
	switch {
	case strings.HasSuffix(key, ".json"):
		return "application/json"
	case strings.HasSuffix(key, ".png"):
		return "image/png"
	case strings.HasSuffix(key, ".jpg"):
		return "image/jpeg"
	case strings.HasSuffix(key, ".mp3"):
		return "audio/mpeg"
	default:
		return "application/octet-stream"
	}
}
