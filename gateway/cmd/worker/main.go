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
	"bytes"
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
	"github.com/syumai/workers/cloudflare/cache"
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

// sprCacheBytes / actCacheBytes budget the Manager's parse caches for a 128 MB
// isolate. The package defaults are sized for the server's ~500 MiB and come to
// 144 MiB between them, which does not fit here: exceeding the ceiling discards
// the parse caches AND the manifest, so the next request pays a full cold start
// including a fresh 1.44 MiB manifest read.
//
// Budget: ~7 MiB module + 1.44 MiB manifest + 36 MiB here + the per-render
// working set, inside 128 MiB.
const (
	sprCacheBytes int64 = 24 << 20
	actCacheBytes int64 = 12 << 20
)

// The runtime bindings are only reachable while a request is in flight, so
// everything is built on the first one and reused for the isolate's lifetime.
//
// Two stages, because they cost very different amounts. bindOnce is cheap and
// every route needs it. renderOnce fetches the 1.44 MiB existence manifest, which
// only /image and /gif consult — folding it into the first stage would block a
// /healthz or /bgm request on a cold isolate behind a download it never reads.
var (
	bindOnce sync.Once
	initErr  error

	renderOnce sync.Once
	renderErr  error

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

func bind() {
	bucket, err := r2.NewBucket(bucketBinding)
	if err != nil {
		initErr = fmt.Errorf("r2 binding %q: %w", bucketBinding, err)
		return
	}
	dataStore = resource.NewR2Store(bucket, deployEpoch, "data/")
	objStore = resource.NewR2Store(bucket, deployEpoch, "")
	// The effect store reads the same bucket through the same cache; only its
	// resolution differs (see internal/effect/store_r2.go).
	estore = effect.NewObjectStore(objStore.Get)
	// Finished renders go in the same colo cache, under their own key space (see
	// rendercache.go).
	renderCache = cache.New()
}

// setupRender fetches the existence manifest and builds the Engine. The manifest
// is read through objStore rather than straight off the binding, so it goes
// through the same epoch-keyed colo cache as everything else: one R2 read per
// colo per deploy rather than one per isolate cold start, forever.
func setupRender() {
	b, err := objStore.Get(manifestKey)
	if err != nil {
		renderErr = fmt.Errorf("load %s: %w", manifestKey, err)
		return
	}
	m, err := resource.LoadManifest(bytes.NewReader(b))
	if err != nil {
		renderErr = fmt.Errorf("parse %s: %w", manifestKey, err)
		return
	}
	exist = m
	// One long-lived Engine, so its parse caches survive across requests. The
	// per-render prefetch warms the colo cache in parallel; the engine's own
	// reads then land on that cache rather than on R2.
	eng = engine.NewWithSourceBudget(dataStore, exist, resolve.DefaultTables(), sprCacheBytes, actCacheBytes)
}

func main() {
	workers.Serve(http.HandlerFunc(route))
}

func route(w http.ResponseWriter, r *http.Request) {
	bindOnce.Do(bind)
	if initErr != nil {
		fail(w, "worker not initialised: "+initErr.Error(), http.StatusInternalServerError)
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
		serveBytes(w, r, effect.SkillMapJSON, skillMapETag(), "application/json", api.CacheImmutable)
	case p == "/effect/table":
		serveBytes(w, r, effect.EffectTableJSON, effectTableETag(), "application/json", api.CacheImmutable)
	case p == "/effect/str":
		serveEffectFile(w, r, "-effstr", []string{".str"}, "application/json", strToJSON)
	case p == "/effect/texture":
		// name carries the extension TextureToPNG decides BMP-vs-TGA from.
		serveEffectFile(w, r, "-efftex", []string{".bmp", ".tga"}, "image/png", effect.TextureToPNG)
	case p == "/effect/sound":
		handleEffectSound(w, r)
	case p == "/effect/sound/index.json":
		serveObject(w, r, "sounds/index.json", api.CacheImmutable)
	case strings.HasPrefix(p, "/maps/"), strings.HasPrefix(p, "/bgm/"):
		serveObject(w, r, strings.TrimPrefix(p, "/"), api.CacheImmutable)
	default:
		missing(w, r)
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
		Isolate string           `json:"isolate"`
		Epoch   string           `json:"epoch"`
		Data    resource.Stats   `json:"data"`
		Objects resource.Stats   `json:"objects"`
		Renders RenderCacheStats `json:"renders"`
	}
	out, err := json.Marshal(payload{
		Isolate: isolateID,
		Epoch:   deployEpoch,
		Data:    dataStore.Stats(),
		Objects: objStore.Stats(),
		Renders: renderCacheStats(),
	})
	if err != nil {
		fail(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	writeBody(w, out)
}

// handleRender serves /image and /gif, which differ only in the final encode.
//
// Its three tiers are ordered by what they cost, cheapest first, and the ordering
// is the point: nothing expensive happens until everything cheap has failed to
// answer.
//
//	304 from the ETag     no I/O at all — the validator is a hash of the query
//	colo cache hit        one local read of a finished render
//	render                the manifest, an R2 batch, and ~86 ms of wasm CPU
//
// setupRender in particular is deliberately not first any more. It downloads and
// parses the 1.44 MiB existence manifest on an isolate's first render, and a
// request the first two tiers can answer has no use for it.
func handleRender(w http.ResponseWriter, r *http.Request, asGIF bool) {
	kind := "image"
	if asGIF {
		kind = "gif"
	}
	tr := startTrace(kind)

	q := r.URL.Query()
	req, ext, err := api.BuildRequest(q)
	if err != nil {
		fail(w, err.Error(), http.StatusBadRequest)
		return
	}
	if ext != ".png" {
		// A frame archive (zip) is a different response shape; the server still
		// handles those and the Worker does not yet.
		fail(w, "frame archives are not implemented on the Worker yet", http.StatusNotImplemented)
		return
	}

	// The ETag comes from the query alone, so a conditional request is answered
	// before any asset is read — the cheapest possible hit. /gif must not share
	// /image's validator for the same query, hence the suffix.
	etag := api.ETagFor(q)
	if asGIF {
		etag += "-gif"
	}
	// SetAssetHeaders is deliberately not hoisted above these branches. Stamping
	// an immutable Cache-Control and an ETag before the work that can fail is what
	// let a transient 500 be cached and then revalidated into a 304 forever; see
	// fail() for the full account.
	if api.IfNoneMatch(r, etag) {
		api.SetAssetHeaders(w, etag, api.CacheImmutable)
		w.WriteHeader(http.StatusNotModified)
		return
	}

	body, contentType, ok := cachedRender(etag)
	tr.mark("cache-lookup")
	if ok {
		api.SetAssetHeaders(w, etag, api.CacheImmutable)
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
		writeBody(w, body)
		tr.mark("done-cached")
		return
	}
	renderCacheMisses.Add(1)

	if !acquireRenderSlot() {
		// Shed rather than queue further. A 503 with Retry-After is something a
		// caller can act on; a request held until the runtime kills it is not.
		w.Header().Set("Retry-After", "1")
		fail(w, "too many renders in flight; retry", http.StatusServiceUnavailable)
		tr.mark("shed")
		return
	}
	defer releaseRenderSlot()
	tr.mark("admitted")

	renderOnce.Do(setupRender)
	tr.mark("setup")
	if renderErr != nil {
		fail(w, "renderer not initialised: "+renderErr.Error(), http.StatusInternalServerError)
		return
	}

	// Plan first, then fetch everything the plan names in one parallel batch.
	// Fetching lazily mid-render would serialise 7-41 round trips at 20-40 ms
	// each, against 4-8 ms of actual rendering.
	//
	// Keys whose parsed form this isolate already holds are dropped from the
	// batch. That is not the same win as the render cache and does not overlap
	// with it: this is the *different* URL that shares sprites with one already
	// served — every preview on a paperdoll grid shares a body and a head — where
	// the fetch would pull tens of kilobytes across the JS boundary only for the
	// Manager to discard them and use the struct it already had.
	plan := eng.Plan(req)
	keys := uncachedKeys(plan.Keys)
	tr.mark(fmt.Sprintf("planned n=%d fetch=%d", len(plan.Keys), len(keys)))
	dataStore.Prefetch(keys, exist)
	tr.mark("prefetched")

	res, err := eng.RenderPlanned(req, plan)
	tr.mark("rendered")
	if err != nil {
		fail(w, "render: "+err.Error(), http.StatusInternalServerError)
		return
	}
	out, err := encode.Animation(res.Frames, res.IntervalMs)
	tr.mark("encoded")
	if err != nil {
		fail(w, "encode: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// contentType is already declared by the cache lookup above.
	contentType = "image/png"
	if asGIF {
		if out, err = gifenc.FromAPNG(out); err != nil {
			fail(w, "gif: "+err.Error(), http.StatusInternalServerError)
			return
		}
		contentType = "image/gif"
	}

	putRender(etag, contentType, out)
	tr.mark("stored")

	api.SetAssetHeaders(w, etag, api.CacheImmutable)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
	writeBody(w, out)
	tr.mark("done")
}

// Admission control for renders.
//
// Bounded awaits in the R2 store are what stop a request hanging; this is the
// second half, and it addresses a different thing: how much work one wasm
// instance is holding at once. The shim reuses a single Go instance per isolate
// and runs every request as a goroutine in it, so 60 concurrent renders meant one
// 128 MiB isolate carrying 60 render working sets and, through Prefetch, several
// hundred goroutines parked on JS promises. Capping that keeps the instance
// inside a footprint that has actually been measured.
//
// Cache hits are deliberately not gated. They allocate nothing beyond the
// response, they are the overwhelming majority of traffic once the render cache
// is warm, and making them queue behind renders would undo the latency win that
// cache exists for.
//
// The cap is generous rather than tight, because the evidence does not support a
// tight one: the failures were never load-proportional (4 concurrent gave 18
// failures, 8 gave 0, 16 gave 28, 56 gave 0). This is a ceiling on the worst
// case, not a throttle on the normal one.
const (
	maxConcurrentRenders = 8
	// admissionTimeout is bounded well inside the runtime's own hang detector, so
	// a queue that is not draining fails as a 503 the caller can retry rather than
	// as a killed request the caller sees as a dead connection.
	admissionTimeout = 10 * time.Second
)

var renderSlots = make(chan struct{}, maxConcurrentRenders)

// acquireRenderSlot blocks until a slot is free, or gives up.
func acquireRenderSlot() bool {
	timer := time.NewTimer(admissionTimeout)
	defer timer.Stop()
	select {
	case renderSlots <- struct{}{}:
		return true
	case <-timer.C:
		return false
	}
}

func releaseRenderSlot() { <-renderSlots }

// uncachedKeys drops the plan keys the engine has already parsed. The answer is
// advisory — see resource.Manager.Cached — so a key that is evicted between this
// call and the render simply reaches R2 through the ordinary path, exactly as a
// key nobody prefetched would.
func uncachedKeys(keys []string) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		if !eng.Cached(k) {
			out = append(out, k)
		}
	}
	return out
}

// serveEffectFile is the shape /effect/str and /effect/texture share: resolve one
// file out of the effect tree, transform it, send it. They differ only in the
// ETag suffix, the extensions they accept, the transform and the content type —
// so keeping one body means their caching and 404 behaviour cannot drift apart.
func serveEffectFile(w http.ResponseWriter, r *http.Request, etagSuffix string, exts []string, contentType string, convert func(data []byte, name string) ([]byte, error)) {
	q := r.URL.Query()
	file := q.Get("file")
	if file == "" {
		fail(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}
	etag := api.ETagFor(q) + etagSuffix
	if api.IfNoneMatch(r, etag) {
		api.SetAssetHeaders(w, etag, api.CacheImmutable)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	data, name, ok, err := estore.Read(file, exts)
	if err != nil || !ok {
		missing(w, r)
		return
	}
	out, err := convert(data, name)
	if err != nil {
		fail(w, "convert: "+err.Error(), http.StatusInternalServerError)
		return
	}
	api.SetAssetHeaders(w, etag, api.CacheImmutable)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
	writeBody(w, out)
}

// strToJSON parses one .str world/skill effect into JSON.
func strToJSON(data []byte, _ string) ([]byte, error) {
	parsed, err := effect.ParseStr(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(parsed)
}

// handleEffectSound serves one WAV from the extracted data/wav tree. `file` is a
// name relative to it without the extension — the token the effect table's `wav`
// field carries. A name the client never shipped 404s, which callers treat as
// "no sound for this effect" and skip, so a wrong sound is never served in place
// of a missing one.
func handleEffectSound(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file == "" {
		fail(w, "missing 'file' query parameter", http.StatusBadRequest)
		return
	}
	key, ok := soundKey(file)
	if !ok {
		missing(w, r)
		return
	}
	serveObject(w, r, key, api.CacheImmutable)
}

// soundKey folds a sound token to an object key under sounds/, rejecting any
// attempt to climb out of that subtree.
//
// The case fold matches the server's soundPath and the bucket, which is
// lowercased on upload. Without it a mixed-case token — /effect/sound?file=
// StormGust — 200s on the server and 404s here.
func soundKey(file string) (string, bool) {
	f := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(file, "\\", "/")))
	if f == "" || strings.HasPrefix(f, "/") {
		return "", false
	}
	if !strings.HasSuffix(f, ".wav") {
		f += ".wav"
	}
	clean := path.Clean(f)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return "sounds/" + clean, true
}

// fail and missing are the only two ways this Worker may answer with a non-2xx,
// and they exist because getting that wrong poisoned real browsers for a year.
//
// The failure, in full. handleRender used to call SetAssetHeaders up front, so
// the ETag was ready before any asset was read and a conditional request could be
// answered at once. That also stamped `Cache-Control: public, max-age=31536000,
// immutable` and an ETag onto every *error* the render then produced. An explicit
// max-age makes a response storable whatever its status, so a browser kept the
// 500. Worse, the ETag is a hash of the query alone and so still matched on the
// next visit: the Worker answered 304, and the browser re-served the error body it
// had. A transient failure — the "Go program has already exited" window, an R2
// hiccup — became a permanently broken image that only a cache-bypassing reload
// could clear. The EC2 server never did this; it sets the headers with the content
// already in hand, which is why the bug arrived with the Cloudflare port.
//
// So: an error carries no validator anything could revalidate against, and says
// no-store.
func fail(w http.ResponseWriter, msg string, code int) {
	api.SetErrorHeaders(w)
	http.Error(w, msg, code)
}

// missing answers "this asset does not exist" — a distinct thing from a failure,
// and the reason it is not simply fail: callers treat a 404 as "no effect here"
// and skip it, so re-asking on every request is waste. It is still not immutable.
// Absence is not permanent — a client patch adds files — and the ETag would not
// change when one arrived, since it hashes the query rather than the bytes. It
// also cannot be distinguished from a read that failed: effect.ObjectStore.Read
// reports both as "not found". Five minutes bounds both mistakes; a year does not.
func missing(w http.ResponseWriter, r *http.Request) {
	api.SetMissingHeaders(w)
	http.NotFound(w, r)
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
	// A validator this isolate already knows answers a conditional request
	// without reading the object at all. That matters most where it costs most: a
	// BGM track is 2-4 MB, and both the R2 read and the SHA-256 over it would be
	// thrown away on the 304.
	if etag, ok := knownETag(key); ok && api.IfNoneMatch(r, etag) {
		api.SetAssetHeaders(w, etag, cacheControl)
		w.Header().Set("Content-Type", contentTypeFor(key))
		w.WriteHeader(http.StatusNotModified)
		return
	}
	b, err := objStore.Get(key)
	if err != nil {
		missing(w, r)
		return
	}
	etag := api.ETagForBytes(b)
	rememberETag(key, etag)
	serveBytes(w, r, b, etag, contentTypeFor(key), cacheControl)
}

// etagByKey memoises content validators per object key, for this isolate. The
// maps/bgm working set is small (~620 requests per six hours across the whole
// store), but the ceiling is there so an unusual traffic pattern cannot grow the
// map without bound.
const maxETagEntries = 4096

var (
	etagMu    sync.Mutex
	etagByKey = map[string]string{}
)

func knownETag(key string) (string, bool) {
	etagMu.Lock()
	defer etagMu.Unlock()
	e, ok := etagByKey[key]
	return e, ok
}

func rememberETag(key, etag string) {
	etagMu.Lock()
	defer etagMu.Unlock()
	if len(etagByKey) >= maxETagEntries {
		// Dropping the lot is fine: these are a pure optimisation, and the next
		// request for a key re-derives it.
		etagByKey = make(map[string]string, maxETagEntries)
	}
	etagByKey[key] = etag
}

// skillMapETag / effectTableETag validate two //go:embed blobs whose bytes are
// fixed for the life of the build, so they are hashed once per isolate rather
// than on every request — 171 KB of SHA-256 in wasm is not free.
var (
	skillMapETag    = sync.OnceValue(func() string { return api.ETagForBytes(effect.SkillMapJSON) })
	effectTableETag = sync.OnceValue(func() string { return api.ETagForBytes(effect.EffectTableJSON) })
)

func serveBytes(w http.ResponseWriter, r *http.Request, body []byte, etag, contentType, cacheControl string) {
	api.SetAssetHeaders(w, etag, cacheControl)
	w.Header().Set("Content-Type", contentType)
	if api.IfNoneMatch(r, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	writeBody(w, body)
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
	case strings.HasSuffix(key, ".wav"):
		return "audio/wav"
	default:
		return "application/octet-stream"
	}
}
