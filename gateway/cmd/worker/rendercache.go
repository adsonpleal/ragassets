//go:build js && wasm

package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"

	"github.com/syumai/workers/cloudflare/cache"

	"github.com/ragassets/gateway/internal/render/resource"
)

// The finished-render cache.
//
// Every other cache in this Worker caches an *input*: R2Store keeps sprite bytes
// so a render does not pay for them twice. Nothing kept the *output*, so two
// requests for the same paperdoll re-planned, re-read and re-rendered it from
// scratch — measured at ~86 ms of wasm CPU for an identical URL that had already
// been answered seconds earlier, against ~20 ms for the same URL served from
// here.
//
// This is not merely a CPU saving, and the reason is isolate fan-out: a colo runs
// several instances of this Worker at once (five, sampled over ten sequential
// requests to /debug/r2), each with its own parse caches and its own copy of the
// existence manifest. Requests round-robin between them, so the in-isolate LRU
// only ever sees a fraction of the repeats. The Cache API is per-colo and shared
// by all of them, and it survives isolate eviction — it is the only layer in the
// stack that sees a repeat as a repeat.
//
// Why this is safe to keep forever: a render is fully determined by its query,
// and the key carries the deploy epoch, so new assets mean a new key rather than
// a stale hit. That is the same invalidation contract R2Store already relies on.
//
// Why the response is not simply left to Cloudflare's ordinary zone cache: on a
// Worker route the Worker runs *in front of* the cache, so a response it returns
// is never stored. Confirmed against production, where /image came back with no
// CF-Cache-Status header at all and re-rendered on every request.
var renderCache *cache.Cache

// Counters, sampled through /debug/r2 the same way the R2 ones are. Renders is
// the billed quantity here — CPU time — so it is the number to watch.
var (
	renderCacheHits   atomic.Int64
	renderCacheMisses atomic.Int64
)

// RenderCacheStats reports this isolate's cumulative render-cache counters.
type RenderCacheStats struct {
	Hits   int64 `json:"hits"`
	Misses int64 `json:"renders"`
}

func renderCacheStats() RenderCacheStats {
	return RenderCacheStats{Hits: renderCacheHits.Load(), Misses: renderCacheMisses.Load()}
}

// renderCacheKey is the synthetic URL a finished render is stored under.
//
// The ETag is the whole key, which is exactly right: api.ETagFor already hashes
// the query canonically — sorted keys, sorted values, empties dropped — so
// ?job=1&head=2 and ?head=2&job=1 are one entry rather than two. Using the real
// request URL instead would split them, and would also let a viewer address the
// cache directly.
func renderCacheKey(etag string) string {
	return "https://render.internal/v" + deployEpoch + "/" + etag
}

// cachedRender returns a previously rendered body and its content type.
func cachedRender(etag string) (body []byte, contentType string, ok bool) {
	req, err := http.NewRequest(http.MethodGet, renderCacheKey(etag), nil)
	if err != nil {
		return nil, "", false
	}
	res, err := renderCache.Match(req, nil)
	if err != nil || res == nil || res.Body == nil {
		return nil, "", false
	}
	b, err := io.ReadAll(res.Body)
	res.Body.Close()
	// A truncated entry is worth ignoring rather than failing on: the render can
	// still be produced, and doing so replaces the entry.
	if err != nil || len(b) == 0 {
		return nil, "", false
	}
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		return nil, "", false
	}
	renderCacheHits.Add(1)
	return b, ct, true
}

// putRender stores a finished render.
//
// Written inline rather than through ctx.waitUntil, and that is deliberate: the
// shim reuses one wasm instance across requests, so the runtime context Go
// captured belongs to whichever request booted it. Its waitUntil would extend a
// lifetime that ended long ago. The write is a few kilobytes into a local cache;
// paying for it on the miss path is the honest trade.
//
// Failures are ignored on purpose — an uncached render is slower next time, not
// wrong, and the bytes are already on their way to the client.
func putRender(etag, contentType string, body []byte) {
	req, err := http.NewRequest(http.MethodGet, renderCacheKey(etag), nil)
	if err != nil {
		return
	}
	res := &http.Response{
		StatusCode:    http.StatusOK,
		Header:        http.Header{},
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
	}
	// The entry has to be cacheable on its own terms or the Cache API drops it.
	// Immutable is truthful: the epoch is in the key, so these bytes never change.
	res.Header.Set("Cache-Control", "public, max-age=31536000, immutable")
	res.Header.Set("Content-Type", contentType)
	res.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	// Bounded, because this is an await like any other. /debug/r2's in-flight
	// snapshot caught a render sitting at `encoded` — the stage immediately before
	// this call — for over ten seconds, which is the same wedged-promise failure
	// the R2 store was hardened against and the last unbounded one left.
	_, _ = resource.Await(resource.ReadTimeout, func() (struct{}, error) {
		return struct{}{}, renderCache.Put(req, res)
	})
}
