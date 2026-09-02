package resource

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Source and Existence are the seam between the renderer and wherever the asset
// bytes actually live. On the server that is the local filesystem; in a Workers
// build it is an object store reached asynchronously, which cannot be read from
// inside a synchronous render.
//
// Splitting them apart is what makes the async case tractable: the caller
// resolves what a render needs (using Existence, which is cheap and answerable
// from a baked manifest), fetches those keys in one batch, and hands the engine a
// MapSource it can read synchronously. The engine, the caches, and every parser
// below them stay unchanged and unaware.
//
// A key is a forward-slashed path relative to the resource tree's data/
// directory, extension included:
//
//	sprite/인간족/몸통/남/검사_남.spr
//	palette/머리/머리1_남_0.pal
//	imf/검사_남.imf
//
// Forward slashes always, on every platform — the key doubles as an object key,
// and FSSource is the only thing that knows about OS path separators.
type Source interface {
	// Get returns the bytes for a key. The error is reported to callers and
	// cached as a negative result, so it should be stable for a missing key
	// (wrap fs.ErrNotExist) rather than varying per call.
	Get(key string) ([]byte, error)
}

// Existence answers whether a key is present without fetching it.
//
// This is deliberately not part of Source. The renderer probes candidate sprite
// paths far more often than it reads them — loadGarment alone can test a dozen
// pairs before finding one — so over a network these have to be answerable
// without a round trip.
type Existence interface {
	Has(key string) bool
}

// Key builds a resource key from a category folder, a resolved name and an
// extension. Names arrive slash-separated already; this is the one place the
// convention is spelled out.
func Key(folder, name, ext string) string {
	return folder + "/" + name + "." + ext
}

// FSSource reads keys from a resource tree on disk, rooted at the directory that
// contains "data/".
type FSSource struct{ Root string }

func (s FSSource) Get(key string) ([]byte, error) { return os.ReadFile(s.path(key)) }

func (s FSSource) path(key string) string {
	return filepath.Join(s.Root, "data", filepath.FromSlash(key))
}

// FSExistence probes the same tree with stat.
type FSExistence struct{ Root string }

func (e FSExistence) Has(key string) bool {
	_, err := os.Stat(filepath.Join(e.Root, "data", filepath.FromSlash(key)))
	return err == nil
}

// MapSource serves keys from memory. It is what a prefetching caller hands the
// engine once it has gathered a render's bytes, and it is the whole reason the
// engine never has to know that a fetch might be asynchronous.
//
// A key that was not prefetched is a miss, not an empty read: returning
// fs.ErrNotExist rather than nil bytes keeps the failure loud, because a silent
// empty sprite would render as a hole rather than an error.
type MapSource map[string][]byte

func (m MapSource) Get(key string) ([]byte, error) {
	if b, ok := m[key]; ok {
		return b, nil
	}
	return nil, fmt.Errorf("resource %q not prefetched: %w", key, fs.ErrNotExist)
}

// MapExistence answers from the same map, for tests and for callers that have
// already narrowed the candidate set.
type MapExistence map[string][]byte

func (m MapExistence) Has(key string) bool {
	_, ok := m[key]
	return ok
}

// SetExistence answers from a bare key set — the shape a baked manifest takes,
// where the keys are known but the bytes are not held.
type SetExistence map[string]struct{}

func (s SetExistence) Has(key string) bool {
	_, ok := s[key]
	return ok
}
