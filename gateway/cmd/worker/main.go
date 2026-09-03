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
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/syumai/workers"
	"github.com/syumai/workers/cloudflare/r2"

	"github.com/ragassets/gateway/internal/api"
	"github.com/ragassets/gateway/internal/effect"
	"github.com/ragassets/gateway/internal/render/encode"
	"github.com/ragassets/gateway/internal/render/engine"
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

	store *resource.R2Store
	exist resource.Existence
	eng   *engine.Engine
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
	store = resource.NewR2Store(bucket, deployEpoch)
	exist = m
	// One long-lived Engine, so its parse caches survive across requests. The
	// per-render prefetch warms the colo cache in parallel; the engine's own
	// reads then land on that cache rather than on R2.
	eng = engine.NewWithSource(store, exist, resolve.DefaultTables())
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
	case p == "/healthz":
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok")
	case p == "/image":
		handleImage(w, r)
	case p == "/effect/skill-map":
		serveBytes(w, r, effect.SkillMapJSON, "application/json", api.CacheImmutable)
	case p == "/effect/table":
		serveBytes(w, r, effect.EffectTableJSON, "application/json", api.CacheImmutable)
	case strings.HasPrefix(p, "/maps/"):
		serveObject(w, r, strings.TrimPrefix(p, "/"), api.CacheImmutable)
	case strings.HasPrefix(p, "/bgm/"):
		serveObject(w, r, strings.TrimPrefix(p, "/"), api.CacheImmutable)
	default:
		// /gif and /effect/{str,texture,sound} are not ported yet; see the README
		// migration notes. Answering explicitly beats a silent 404 that would look
		// like a missing asset.
		http.Error(w, "not implemented on the Worker yet: "+p, http.StatusNotImplemented)
	}
}

func handleImage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	req, ext, err := api.BuildRequest(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if ext != ".png" {
		http.Error(w, "frame archives are not implemented on the Worker yet", http.StatusNotImplemented)
		return
	}

	// The ETag is derived from the query alone, so a conditional request can be
	// answered before any asset is read — the cheapest possible hit.
	etag := api.ETagFor(q)
	setAssetHeaders(w, etag, api.CacheImmutable)
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	// Plan first, then fetch everything the plan names in one parallel batch.
	// Fetching lazily mid-render would serialise 7-41 round trips at 20-40 ms
	// each, against 4-8 ms of actual rendering.
	plan := eng.Plan(req)
	store.Prefetch(plan.Keys, exist)

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

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
	w.Write(out)
}

// serveObject streams one R2 object straight through, for the stores that are
// plain key-to-bytes: maps and bgm.
//
// It does not consult the manifest. That covers only the renderer's tree
// (data/{sprite,palette,imf}), so a miss here would not be authoritative — R2
// itself is the authority for these prefixes.
func serveObject(w http.ResponseWriter, r *http.Request, key, cacheControl string) {
	b, err := store.Get(key)
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
	io.Copy(w, bytes.NewReader(body))
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
