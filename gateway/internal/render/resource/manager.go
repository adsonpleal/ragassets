// Package resource loads and caches parsed RO assets (spr/act/pal/imf) from a
// resource directory laid out as <root>/data/{sprite,palette,imf}/<name>.<ext>.
// It mirrors zrenderer's resource.ResourceManager but caches parsed, immutable
// results (per-request mutations like shadow scaling are applied by the engine,
// never to the cached structs).
package resource

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/ragassets/zrenderer-gateway/internal/render/roformat"
)

// Manager locates and caches parsed resources under a root directory.
type Manager struct {
	root string

	mu  sync.RWMutex
	spr map[string]sprEntry
	act map[string]actEntry
	pal map[string]palEntry
	imf map[string]imfEntry
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
// directory that contains "data/").
func NewManager(root string) *Manager {
	return &Manager{
		root: root,
		spr:  map[string]sprEntry{},
		act:  map[string]actEntry{},
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

// Spr returns the parsed .spr for a resolved sprite name (cached, incl. errors).
func (m *Manager) Spr(name string) (*roformat.Spr, error) {
	m.mu.RLock()
	e, ok := m.spr[name]
	m.mu.RUnlock()
	if ok {
		return e.v, e.err
	}
	var e2 sprEntry
	if data, err := m.readFile("sprite", name, "spr"); err != nil {
		e2.err = err
	} else {
		e2.v, e2.err = roformat.ParseSpr(data)
	}
	m.mu.Lock()
	m.spr[name] = e2
	m.mu.Unlock()
	return e2.v, e2.err
}

// Act returns the parsed .act for a resolved sprite name (cached, incl. errors).
func (m *Manager) Act(name string) (*roformat.Act, error) {
	m.mu.RLock()
	e, ok := m.act[name]
	m.mu.RUnlock()
	if ok {
		return e.v, e.err
	}
	var e2 actEntry
	if data, err := m.readFile("sprite", name, "act"); err != nil {
		e2.err = err
	} else {
		e2.v, e2.err = roformat.ParseAct(data)
	}
	m.mu.Lock()
	m.act[name] = e2
	m.mu.Unlock()
	return e2.v, e2.err
}

// Pal returns the parsed .pal for a resolved palette name (cached, incl. errors).
func (m *Manager) Pal(name string) (roformat.Palette, error) {
	m.mu.RLock()
	e, ok := m.pal[name]
	m.mu.RUnlock()
	if ok {
		return e.v, e.err
	}
	var e2 palEntry
	if data, err := m.readFile("palette", name, "pal"); err != nil {
		e2.err = err
	} else {
		e2.v, e2.err = roformat.ParsePal(data)
	}
	m.mu.Lock()
	m.pal[name] = e2
	m.mu.Unlock()
	return e2.v, e2.err
}

// Imf returns the parsed .imf for a resolved imf name (cached, incl. errors).
func (m *Manager) Imf(name string) (*roformat.Imf, error) {
	m.mu.RLock()
	e, ok := m.imf[name]
	m.mu.RUnlock()
	if ok {
		return e.v, e.err
	}
	var e2 imfEntry
	if data, err := m.readFile("imf", name, "imf"); err != nil {
		e2.err = err
	} else {
		e2.v, e2.err = roformat.ParseImf(data)
	}
	m.mu.Lock()
	m.imf[name] = e2
	m.mu.Unlock()
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
