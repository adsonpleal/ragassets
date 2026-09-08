package resource

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Source and Existence are the seam between the renderer and wherever the asset
// bytes actually live. In production that is the local filesystem, under the
// merged client mirror; in tests it is a map.
//
// They are two interfaces rather than one because "does this exist?" and "give me
// the bytes" have very different costs. Keeping them apart lets a caller resolve
// everything a render needs through Existence first and fetch those keys in one
// batch, so the render itself never blocks on a lookup — see engine.BuildPlan.
// The engine, the caches, and every parser below them stay unaware of which
// implementation they are on.
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

// MapSource serves keys from memory — a Source over bytes a caller already
// holds. The golden tests use it to drive a render entirely from a fixture set,
// which is what proves the engine never reaches past its Source.
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
