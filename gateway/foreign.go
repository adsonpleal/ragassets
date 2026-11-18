// Serving a costume that only exists in another official server's client.
//
// The asset trees sit beside the merged LATAM mirror, one directory per origin,
// because the same resource key names different art in different clients: the
// LATAM 남_두건 and the kRO Zero one are both real files and not the same
// picture. Merging them into the mirror would silently overwrite one. So each
// origin is its own tree, read in front of the mirror rather than instead of it
// — a foreign costume takes its hat from its own client and everything else
// about the character (body, head, palettes) from ours.
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/ragassets/gateway/internal/api"
	"github.com/ragassets/gateway/internal/render/engine"
	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/resource"
)

// Per-origin cache budgets, much smaller than the default tree's 96/48 MiB.
//
// A foreign render reads one hat (or one garment) from its own tree and
// everything else through the overlay, so each of these caches ends up holding
// a body and a head it shares with no one — the cost of not letting two origins
// collide on one cache key. The budget is sized so that every origin being hot
// at once still fits the box's GOMEMLIMIT=500MiB beside the main engine, with
// maxForeignOrigins as the backstop on that arithmetic.
const (
	foreignSprCacheBytes int64 = 12 << 20 // 12 MiB
	foreignActCacheBytes int64 = 6 << 20  // 6 MiB
	maxForeignOrigins          = 12
)

// foreignTrees holds the origins that are mounted and builds their engines on
// first use. Lazily, because an origin nobody asks for should cost no memory:
// this is behind a filter that is off by default.
type foreignTrees struct {
	root  string   // directory holding one subdirectory per origin
	ids   []string // mounted origin ids, sorted
	base  resource.Source
	baseX resource.Existence

	mu      sync.Mutex
	engines map[string]*engine.Engine
	lru     []string // engine keys, least recently used first
}

// maxForeignEngines caps how many origin combinations stay resident. Each one
// holds its own caches, so the ceiling is what keeps the arithmetic bounded now
// that a request may name a *set* of origins and the number of sets is
// combinatorial. Least recently used is evicted; rebuilding one is cheap (it
// reads nothing until a render asks it to).
const maxForeignEngines = 8

// mountForeign scans root for origin directories. A tree counts as an origin
// when it has a data/ subdirectory, the same test main() applies to
// RESOURCE_DIR: a directory that does not is a staging leftover, not a client.
func mountForeign(root, resourceDir string) *foreignTrees {
	f := &foreignTrees{
		root:    root,
		base:    resource.FSSource{Root: resourceDir},
		baseX:   resource.FSExistence{Root: resourceDir},
		engines: make(map[string]*engine.Engine),
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		log.Printf("foreign: %s not readable — /image?origin=... will 400 (%v)", root, err)
		return f
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		if _, err := api.ParseOriginID(id); err != nil {
			log.Printf("foreign: ignoring %q — not a usable origin id (%v)", id, err)
			continue
		}
		if fi, err := os.Stat(filepath.Join(root, id, "data")); err != nil || !fi.IsDir() {
			log.Printf("foreign: ignoring %q — no data/ subdir", id)
			continue
		}
		if len(f.ids) >= maxForeignOrigins {
			log.Printf("foreign: ignoring %q and any further origin — at the %d-origin cap", id, maxForeignOrigins)
			break
		}
		f.ids = append(f.ids, id)
	}
	sort.Strings(f.ids)
	if len(f.ids) == 0 {
		log.Printf("foreign: no origin trees under %s — /image?origin=... will 400", root)
	} else {
		log.Printf("foreign: serving /image?origin={%v} from %s (over %s)", f.ids, root, resourceDir)
	}
	return f
}

// IDs returns the mounted origins, for the help text and for diagnostics.
func (f *foreignTrees) IDs() []string { return f.ids }

// engineFor returns the engine reading these origins' trees, in order, in front
// of the default one. The error names what is mounted: an unknown origin is a
// caller mistake worth being specific about, since the alternative — quietly
// falling back to the default tree — renders the wrong hat or no hat at all,
// with a 200.
func (f *foreignTrees) engineFor(origins []string) (*engine.Engine, error) {
	if len(origins) == 0 {
		return nil, fmt.Errorf("no origin given")
	}
	key := strings.Join(origins, ",")

	f.mu.Lock()
	defer f.mu.Unlock()
	if e, ok := f.engines[key]; ok {
		f.touch(key)
		return e, nil
	}
	for _, o := range origins {
		if !f.mounted(o) {
			if len(f.ids) == 0 {
				return nil, fmt.Errorf("no foreign origins are available on this server")
			}
			return nil, fmt.Errorf("unknown 'origin' %q; available: %v", o, f.ids)
		}
	}

	// Foreign trees first, in the order the caller gave, then the default tree
	// behind all of them: a costume comes from its own client, everything else
	// from ours.
	srcs := make(resource.OverlaySource, 0, len(origins)+1)
	exs := make(resource.OverlayExistence, 0, len(origins)+1)
	for _, o := range origins {
		dir := filepath.Join(f.root, o)
		srcs = append(srcs, resource.FSSource{Root: dir})
		exs = append(exs, resource.FSExistence{Root: dir})
	}
	srcs = append(srcs, f.base)
	exs = append(exs, f.baseX)

	e := engine.NewWithSourceBudget(srcs, exs, resolve.DefaultTables(), foreignSprCacheBytes, foreignActCacheBytes)
	f.engines[key] = e
	f.lru = append(f.lru, key)
	for len(f.lru) > maxForeignEngines {
		delete(f.engines, f.lru[0])
		f.lru = f.lru[1:]
	}
	return e, nil
}

func (f *foreignTrees) mounted(origin string) bool {
	for _, id := range f.ids {
		if id == origin {
			return true
		}
	}
	return false
}

// touch moves key to the most-recently-used end. Called under f.mu.
func (f *foreignTrees) touch(key string) {
	for i, k := range f.lru {
		if k == key {
			f.lru = append(f.lru[:i], f.lru[i+1:]...)
			break
		}
	}
	f.lru = append(f.lru, key)
}

// renderFor picks the engine and the name overrides a request needs. A request
// with no origin is the ordinary path and gets the default engine untouched.
func (s *server) renderFor(fr api.Foreign) (*engine.Engine, resolve.Tables, error) {
	if fr.Empty() {
		return s.eng, nil, nil
	}
	e, err := s.foreign.engineFor(fr.Origins)
	if err != nil {
		return nil, nil, err
	}
	return e, resolve.SpriteNames{
		Tables: resolve.DefaultTables(),
		Acc:    fr.Headgear,
		Robe:   fr.Garment,
	}, nil
}
