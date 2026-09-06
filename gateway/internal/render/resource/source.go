package resource

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Source and Existence are the seam between the renderer and wherever the asset
// bytes actually live. On the server that is the local filesystem; in a Workers
// build it is an object store reached asynchronously, which cannot be read from
// inside a synchronous render.
//
// Splitting them apart is what makes the async case tractable: the caller
// resolves what a render needs (using Existence, which is cheap and answerable
// from a baked manifest) and fetches those keys in one concurrent batch before
// the render starts, so every read the engine then makes is answered locally. The
// engine, the caches, and every parser below them stay unchanged and unaware.
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

// SplitKey is Key's inverse: it recovers the folder, name and extension a key
// was built from. Names contain slashes ("인간족/몸통/남/검사_남"), so the split is at the
// first separator and the last dot, not anywhere in between.
//
// It exists so a caller holding a plan's keys can ask the Manager what it has
// already parsed, which is otherwise unanswerable: the Manager caches per folder
// and name, and the plan speaks only keys.
func SplitKey(key string) (folder, name, ext string, ok bool) {
	slash := strings.IndexByte(key, '/')
	dot := strings.LastIndexByte(key, '.')
	if slash <= 0 || dot <= slash+1 || dot == len(key)-1 {
		return "", "", "", false
	}
	return key[:slash], key[slash+1 : dot], key[dot+1:], true
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
