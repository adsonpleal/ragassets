// Package resource loads and caches parsed RO assets (spr/act/pal/imf) from a
// resource directory laid out as <root>/data/{sprite,palette,imf}/<name>.<ext>.
// It mirrors zrenderer's resource.ResourceManager but caches parsed, immutable
// results (per-request mutations like shadow scaling are applied by the engine,
// never to the cached structs).
//
// spr and act are the two large caches (Spr retains the full file buffer; Act
// parses into structured frame data). Both are bounded with LRU eviction so the
// process footprint stays flat under a large working set — otherwise every
// unique sprite ever requested would sit in memory forever and the container
// eventually gets OOM-killed on a small host. pal and imf are left uncapped:
// their total on-disk sets are tiny (~5 MB combined) and cannot grow without
// bound.
package resource

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/ragassets/gateway/internal/render/roformat"
)

// Default LRU capacities. Sized so the retained cache stays comfortably under
// GOMEMLIMIT (~500 MiB in prod). spr entries retain the raw file buffer
// (avg ~39 KB, occasionally several MB for large monster sprites); act entries
// carry parsed frame data (avg ~15 KB). Callers can override via
// NewManagerWithLimits — the render engine uses these defaults.
const (
	DefaultSprCacheCap = 2000
	DefaultActCacheCap = 3000
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
// directory that contains "data/") using default LRU capacities.
func NewManager(root string) *Manager {
	return NewManagerWithLimits(root, DefaultSprCacheCap, DefaultActCacheCap)
}

// NewManagerWithLimits is NewManager but with explicit LRU capacities for the
// spr and act caches. Values <= 0 fall back to the defaults.
func NewManagerWithLimits(root string, sprCap, actCap int) *Manager {
	if sprCap <= 0 {
		sprCap = DefaultSprCacheCap
	}
	if actCap <= 0 {
		actCap = DefaultActCacheCap
	}
	return &Manager{
		root: root,
		spr:  newLRU[sprEntry](sprCap),
		act:  newLRU[actEntry](actCap),
		pal:  map[string]palEntry{},
		imf:  map[string]imfEntry{},
	}
}

// path builds the on-disk path for a resolved name under a category folder.
func (m *Manager) path(folder, name, ext string) string {
	return filepath.Join(m.root, "data", folder, filepath.FromSlash(name)+"."+ext)
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
	if data, err := m.readFile("sprite", name, "spr"); err != nil {
		e.err = err
	} else {
		e.v, e.err = roformat.ParseSpr(data)
	}
	m.mu.Lock()
	m.spr.put(name, e)
	m.mu.Unlock()
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
	if data, err := m.readFile("sprite", name, "act"); err != nil {
		e.err = err
	} else {
		e.v, e.err = roformat.ParseAct(data)
	}
	m.mu.Lock()
	m.act.put(name, e)
	m.mu.Unlock()
	return e.v, e.err
}

// Pal returns the parsed .pal for a resolved palette name (cached, incl. errors).
// Uncapped: the on-disk .pal set is small (~4 KB per entry, a few thousand total)
// and cannot grow without bound.
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
	m.pal[name] = e2
	m.palMu.Unlock()
	return e2.v, e2.err
}

// Imf returns the parsed .imf for a resolved imf name (cached, incl. errors).
// Uncapped: only a few hundred imf files exist, all small.
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
	m.imf[name] = e2
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
