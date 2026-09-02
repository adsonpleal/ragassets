// Package resource loads and caches parsed RO assets (spr/act/pal/imf) from a
// resource directory laid out as <root>/data/{sprite,palette,imf}/<name>.<ext>.
// It mirrors zrenderer's resource.ResourceManager but caches parsed, immutable
// results (per-request mutations like shadow scaling are applied by the engine,
// never to the cached structs).
//
// spr and act are the two large caches (Spr retains the full file buffer; Act
// parses into structured frame data). Both are bounded by a byte budget with LRU
// eviction so the process footprint stays flat under a large working set —
// otherwise every unique sprite ever requested would sit in memory forever and
// the process eventually gets OOM-killed on a small host.
//
// pal and imf are effectively uncapped: the whole palette tree is 20 MB across
// 4,464 files and the imf tree 3.8 MB across 327, so neither can grow without
// bound. They still carry a defensive entry ceiling, because "bounded by the size
// of the library" is only reassuring while the library stays this size.
package resource

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/ragassets/gateway/internal/render/roformat"
)

// Default cache budgets, in bytes. Sized to sit well inside GOMEMLIMIT (~500 MiB
// in prod) alongside the per-render working set.
//
// These are byte budgets, not entry counts, and the difference is not academic.
// The previous entry-count defaults (2000 spr, 3000 act) implied roughly 219 MB
// against measured averages of 41.1 KB per .spr (81,040 files) and 45.6 KB per
// .act (102,345) — already over budget on the 500 MiB box, and far over for a
// 128 MB Workers isolate. The old doc comment put .act at "~15 KB", which was
// stale by 3x and is what made the counts look safe.
const (
	DefaultSprCacheBytes int64 = 96 << 20 // 96 MiB
	DefaultActCacheBytes int64 = 48 << 20 // 48 MiB

	// maxEntryBytes refuses to retain any single oversized entry. Such a file is
	// still parsed and served — it just is not kept, so one 19.5 MB monster
	// cannot evict the entire hot set of ordinary sprites behind it.
	maxEntryBytes int64 = 2 << 20 // 2 MiB

	// errEntryBytes is the nominal charge for a cached failure. Negative results
	// are worth caching (they stop a missing file being re-stat'd on every
	// request) but hold no payload, so they are charged a token amount rather
	// than zero — otherwise an adversarial miss stream could retain unboundedly
	// many of them for free.
	errEntryBytes int64 = 1 << 10 // 1 KiB

	// maxPalEntries / maxImfEntries bound the two uncapped maps. Both ceilings sit
	// comfortably above the entire on-disk set (4,464 palettes, 327 imf), so in
	// practice neither is ever reached.
	maxPalEntries = 6000
	maxImfEntries = 1000
)

// Manager locates and caches parsed resources under a root directory.
type Manager struct {
	root string

	mu  sync.Mutex // guards spr, act
	spr *lru[sprEntry]
	act *lru[actEntry]

	palMu sync.RWMutex
	pal   map[string]palEntry
	imfMu sync.RWMutex
	imf   map[string]imfEntry
}

type sprEntry struct {
	v   *roformat.Spr
	err error
}
type actEntry struct {
	v   *roformat.Act
	err error
}
type palEntry struct {
	v   roformat.Palette
	err error
}
type imfEntry struct {
	v   *roformat.Imf
	err error
}

// NewManager returns a Manager rooted at the given resource directory (the
// directory that contains "data/") using the default cache budgets.
func NewManager(root string) *Manager {
	return NewManagerWithBudget(root, DefaultSprCacheBytes, DefaultActCacheBytes)
}

// NewManagerWithBudget is NewManager but with explicit byte budgets for the spr
// and act caches. Values <= 0 fall back to the defaults.
//
// Named for bytes rather than "limits" deliberately: it replaced an entry-count
// API, and a caller that had passed a small count would otherwise have silently
// asked for a few-byte cache instead of a few-entry one.
func NewManagerWithBudget(root string, sprBytes, actBytes int64) *Manager {
	if sprBytes <= 0 {
		sprBytes = DefaultSprCacheBytes
	}
	if actBytes <= 0 {
		actBytes = DefaultActCacheBytes
	}
	return &Manager{
		root: root,
		spr:  newLRU[sprEntry](sprBytes),
		act:  newLRU[actEntry](actBytes),
		pal:  map[string]palEntry{},
		imf:  map[string]imfEntry{},
	}
}

// path builds the on-disk path for a resolved name under a category folder.
func (m *Manager) path(folder, name, ext string) string {
	return filepath.Join(m.root, "data", folder, filepath.FromSlash(name)+"."+ext)
}

// cacheSize is the budget charge for an entry parsed from src bytes.
//
// The source file's length stands in for the retained cost. For .spr that is
// close to exact (the parsed form keeps the file buffer); for .act it is an
// approximation of the parsed frame data, which tracks file size closely enough
// to bound the cache. Entries above maxEntryBytes are reported as oversized so
// the caller can serve them without retaining them.
func cacheSize(src []byte) (size int64, oversized bool) {
	n := int64(len(src))
	return n, n > maxEntryBytes
}

// readFile reads a resource file's bytes.
func (m *Manager) readFile(folder, name, ext string) ([]byte, error) {
	return os.ReadFile(m.path(folder, name, ext))
}

// Spr returns the parsed .spr for a resolved sprite name (LRU-cached, incl. errors).
func (m *Manager) Spr(name string) (*roformat.Spr, error) {
	m.mu.Lock()
	if e, ok := m.spr.get(name); ok {
		m.mu.Unlock()
		return e.v, e.err
	}
	m.mu.Unlock()

	var e sprEntry
	size, oversized := errEntryBytes, false
	if data, err := m.readFile("sprite", name, "spr"); err != nil {
		e.err = err
	} else {
		e.v, e.err = roformat.ParseSpr(data)
		size, oversized = cacheSize(data)
	}
	if !oversized {
		m.mu.Lock()
		m.spr.put(name, e, size)
		m.mu.Unlock()
	}
	return e.v, e.err
}

// Act returns the parsed .act for a resolved sprite name (LRU-cached, incl. errors).
func (m *Manager) Act(name string) (*roformat.Act, error) {
	m.mu.Lock()
	if e, ok := m.act.get(name); ok {
		m.mu.Unlock()
		return e.v, e.err
	}
	m.mu.Unlock()

	var e actEntry
	size, oversized := errEntryBytes, false
	if data, err := m.readFile("sprite", name, "act"); err != nil {
		e.err = err
	} else {
		e.v, e.err = roformat.ParseAct(data)
		size, oversized = cacheSize(data)
	}
	if !oversized {
		m.mu.Lock()
		m.act.put(name, e, size)
		m.mu.Unlock()
	}
	return e.v, e.err
}

// Pal returns the parsed .pal for a resolved palette name (cached, incl. errors).
// Effectively uncapped — the whole palette tree is 20 MB across 4,464 files — but
// it stops inserting past maxPalEntries so the map cannot outgrow the library it
// is meant to mirror.
func (m *Manager) Pal(name string) (roformat.Palette, error) {
	m.palMu.RLock()
	e, ok := m.pal[name]
	m.palMu.RUnlock()
	if ok {
		return e.v, e.err
	}
	var e2 palEntry
	if data, err := m.readFile("palette", name, "pal"); err != nil {
		e2.err = err
	} else {
		e2.v, e2.err = roformat.ParsePal(data)
	}
	m.palMu.Lock()
	if len(m.pal) < maxPalEntries {
		m.pal[name] = e2
	}
	m.palMu.Unlock()
	return e2.v, e2.err
}

// Imf returns the parsed .imf for a resolved imf name (cached, incl. errors).
// Effectively uncapped — 327 files, 3.8 MB total — with the same defensive
// entry ceiling as Pal.
func (m *Manager) Imf(name string) (*roformat.Imf, error) {
	m.imfMu.RLock()
	e, ok := m.imf[name]
	m.imfMu.RUnlock()
	if ok {
		return e.v, e.err
	}
	var e2 imfEntry
	if data, err := m.readFile("imf", name, "imf"); err != nil {
		e2.err = err
	} else {
		e2.v, e2.err = roformat.ParseImf(data)
	}
	m.imfMu.Lock()
	if len(m.imf) < maxImfEntries {
		m.imf[name] = e2
	}
	m.imfMu.Unlock()
	return e2.v, e2.err
}

// ExistsSpr reports whether a .spr file exists for the resolved name.
func (m *Manager) ExistsSpr(name string) bool { return fileExists(m.path("sprite", name, "spr")) }

// ExistsAct reports whether a .act file exists for the resolved name.
func (m *Manager) ExistsAct(name string) bool { return fileExists(m.path("sprite", name, "act")) }

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
