//go:build js && wasm

package resource

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/syumai/workers/cloudflare/cache"
	"github.com/syumai/workers/cloudflare/r2"
)

// R2Store reads resource keys from an R2 bucket, through the colo edge cache.
//
// The cache is not an optimisation here, it is the cost model. A render's plan
// names 6.47 keys on average and a garment request can reach ~41; without a
// cache in front, 8M renders a month would be on the order of 52M Class B
// operations, past the 10M free tier and costing more than the compute.
//
// Measured on staging against Cloudflare's own r2OperationsAdaptiveGroups,
// replaying 150 real production URLs per run:
//
//	cold, straight after a deploy bumps the epoch   0.85 GetObject per render
//	warm, partially primed                          0.58
//	warm, fully primed                              0.03
//
// So a 91-99% hit rate warm, and even the cold case extrapolates to 6.8M
// operations a month — inside the free tier. The reason it works this well is
// that /image URLs are ~93% unique but the sprite files behind them are heavily
// shared, so the colo cache absorbs nearly everything. A colo's cache is also
// shared by every isolate in it and survives isolate eviction, which the
// in-process LRU does not.
//
// The cold figure is 0.85 rather than 6.47 because within a burst the first
// render of a job warms the cache for every later one; the full 6.47 applies
// only to the first handful of requests after a deploy.
//
// Two things about the cache are easy to get wrong:
//
//   - caches.default is inert on *.workers.dev. Measuring hit rate or R2 op
//     counts there measures nothing; it needs a real route.
//   - the cache key carries a deploy epoch. Bumping it invalidates everything at
//     once, which is the only workable invalidation: purge-by-URL is capped at
//     30 URLs per call and about 1,000 a day, and purge-by-prefix is Enterprise.
type R2Store struct {
	bucket *r2.Bucket
	cache  *cache.Cache
	epoch  string
	// prefix is prepended to every key before it reaches R2.
	//
	// The bucket mirrors the extracted resources tree, so the renderer's inputs
	// live under "data/" — data/sprite/..., data/palette/..., data/imf/... . The
	// Go side addresses them without it: resource.Key builds "sprite/<name>.spr"
	// because FSSource joins root + "data" + key, and cmd/gen-manifest hashes the
	// same un-prefixed form. Something has to bridge the two, and doing it here
	// keeps the engine, the plan and the manifest in one key space.
	//
	// The stores served straight through — maps/, bgm/, sounds/ — are already
	// addressed by their full key, so they use a store with an empty prefix.
	prefix string

	// Counters for the one number that decides this design: how often a read is
	// answered by the colo cache rather than by R2. A Class B operation is only
	// charged on the miss path, so misses is directly the billed quantity — the
	// difference between a few dollars a month and a few tens.
	//
	// misses is exact. The hits/(hits+misses) ratio is an upper bound rather than
	// a per-key hit rate, because Prefetch and the render that follows it each
	// read the same key: a cold key scores one miss and one hit, a warm one scores
	// two hits. Read misses per render, not the ratio.
	//
	// Process-wide and cumulative rather than per-request: they are read by
	// sampling /debug/r2 before and after a batch, which is exact for sequential
	// traffic and good enough for concurrent.
	hits      atomic.Int64
	misses    atomic.Int64
	bytesHit  atomic.Int64
	bytesMiss atomic.Int64
	notFound  atomic.Int64
}

// Stats reports cumulative read counters for this isolate.
type Stats struct {
	Hits      int64 `json:"cacheHits"`
	Misses    int64 `json:"r2Gets"`
	NotFound  int64 `json:"r2NotFound"`
	BytesHit  int64 `json:"bytesFromCache"`
	BytesMiss int64 `json:"bytesFromR2"`
}

func (s *R2Store) Stats() Stats {
	return Stats{
		Hits:      s.hits.Load(),
		Misses:    s.misses.Load(),
		NotFound:  s.notFound.Load(),
		BytesHit:  s.bytesHit.Load(),
		BytesMiss: s.bytesMiss.Load(),
	}
}

// NewR2Store binds a store to a bucket. epoch changes whenever the assets do —
// it is what makes a redeploy invalidate the edge cache. prefix is prepended to
// every key; see the field comment for why the renderer needs "data/".
func NewR2Store(bucket *r2.Bucket, epoch, prefix string) *R2Store {
	return &R2Store{bucket: bucket, cache: cache.New(), epoch: epoch, prefix: prefix}
}

// cacheURL is the synthetic key a resource is cached under. The host is not
// resolved by anything; the Cache API only needs a well-formed URL, and keeping
// it off the public origin means a viewer cannot address the cache directly.
func (s *R2Store) cacheURL(key string) string {
	return "https://r2.internal/v" + s.epoch + "/" + s.prefix + key
}

// Get returns a key's bytes, from the edge cache when possible.
func (s *R2Store) Get(key string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, s.cacheURL(key), nil)
	if err != nil {
		return nil, fmt.Errorf("resource %q: %w", key, err)
	}

	if res, err := s.cache.Match(req, nil); err == nil && res != nil && res.Body != nil {
		b, readErr := io.ReadAll(res.Body)
		res.Body.Close()
		if readErr == nil {
			s.hits.Add(1)
			s.bytesHit.Add(int64(len(b)))
			return b, nil
		}
		// A truncated cache entry is worth ignoring rather than failing on: R2
		// still has the object, and the entry will be replaced below.
	}

	obj, err := s.bucket.Get(s.prefix + key)
	if err != nil {
		return nil, fmt.Errorf("r2 get %q: %w", key, err)
	}
	if obj == nil {
		s.notFound.Add(1)
		// Absent, not broken. Wrapping fs.ErrNotExist keeps this
		// indistinguishable from a filesystem miss, which is what the engine's
		// negative caching and the speculative loads already handle.
		return nil, fmt.Errorf("resource %q: %w", key, fs.ErrNotExist)
	}
	if obj.Body == nil {
		return nil, fmt.Errorf("resource %q: r2 object has no body", key)
	}
	b, err := io.ReadAll(obj.Body)
	if err != nil {
		return nil, fmt.Errorf("r2 read %q: %w", key, err)
	}

	s.misses.Add(1)
	s.bytesMiss.Add(int64(len(b)))
	s.populate(req, b)
	return b, nil
}

// populate writes a fetched object into the edge cache. Failures are ignored on
// purpose: a render that cannot cache is slower and costlier, not wrong, and the
// bytes are already in hand.
func (s *R2Store) populate(req *http.Request, body []byte) {
	res := &http.Response{
		StatusCode:    http.StatusOK,
		Header:        http.Header{},
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
	}
	// The response must be cacheable on its own terms or the Cache API drops it.
	// Immutable is honest here: the epoch in the key means a given URL's bytes
	// never change.
	res.Header.Set("Cache-Control", "public, max-age=31536000, immutable")
	res.Header.Set("Content-Type", "application/octet-stream")
	res.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	_ = s.cache.Put(req, res)
}

// PrefetchLimit bounds how many objects are fetched at once. Each R2 binding
// call is a subrequest, and the paid plan allows 1,000 per invocation; a render
// asks for tens, so this is about not queueing hundreds of promises at once
// rather than about the cap.
const PrefetchLimit = 16

// Prefetch warms the colo cache for a plan's keys, concurrently.
//
// This is the whole reason planning was split from rendering. Go blocks on a JS
// promise by parking the goroutine, not the runtime, so N goroutines each
// awaiting an R2 get have N requests in flight at once. The render that follows
// reads those same keys through Get and finds them already cached, which is a
// local lookup. Fetching them lazily mid-render instead would serialise 7-41 R2
// round trips at 20-40 ms each, against 4-8 ms of actual rendering.
//
// The bytes are deliberately not retained. They live in the colo cache, which is
// shared by every isolate in the colo and survives isolate eviction; holding a
// second copy of a render's whole working set in the isolate would put it against
// the 128 MB ceiling for nothing. What the isolate keeps is the Manager's LRU, of
// parsed sprites, under its own byte budget.
//
// Keys the Existence rejects are skipped rather than fetched. The engine probes
// speculatively and tolerates a miss, so paying a round trip to confirm one would
// be pure waste.
func (s *R2Store) Prefetch(keys []string, ex Existence) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, PrefetchLimit)
	for _, k := range keys {
		if ex != nil && !ex.Has(k) {
			continue
		}
		wg.Add(1)
		go func(key string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			// Absent or unreadable is not an error here: the engine reaches the
			// same key through Get and handles the miss itself.
			_, _ = s.Get(key)
		}(k)
	}
	wg.Wait()
}
