package effect

import (
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// Store resolves and reads raw effect assets under RESOURCE_DIR/data/texture/,
// case-insensitively. GRF paths are EUC-KR with inconsistent casing, and the
// extracted tree preserves whatever the client shipped; prod runs on a
// case-sensitive filesystem, so a lowercased directory index is kept per folder
// (built lazily, then cached — the resource tree is read-only and only changes on
// redeploy, which restarts the process).
type Store struct {
	base string // <resourceDir>/data/texture

	mu  sync.Mutex
	dir map[string]map[string]string // absDir -> lower(entryName) -> realEntryName
}

// NewStore roots a Store at the given resource directory (the one containing
// data/). Effect files live under data/texture/effect; the base is data/texture
// so the rare roBrowser "../npc/…" refs resolve to sibling texture folders while
// escapes above data/texture are rejected.
func NewStore(resourceDir string) *Store {
	return &Store{
		base: filepath.Join(resourceDir, "data", "texture"),
		dir:  map[string]map[string]string{},
	}
}

// ResolveEffect maps a caller-supplied file token (relative to data/texture/effect,
// may use "../" to reach a sibling texture folder) to a real on-disk path, trying
// each extension in exts in order. A candidate that already ends in one of exts
// (case-insensitively) is also tried verbatim. Returns "" if nothing resolves or
// the token escapes data/texture. The lookup is case-insensitive at every segment.
func (s *Store) ResolveEffect(file string, exts []string) (string, bool) {
	rel, ok := effectRel(file)
	if !ok {
		return "", false
	}
	// If the token already carries an accepted extension, try it as-is first.
	if hasAnyExt(rel, exts) {
		if p, ok := s.resolveCI(rel); ok {
			return p, true
		}
	}
	for _, ext := range exts {
		if p, ok := s.resolveCI(rel + ext); ok {
			return p, true
		}
	}
	return "", false
}

// Read resolves and reads a file in one call.
func (s *Store) Read(file string, exts []string) ([]byte, bool, error) {
	p, ok := s.ResolveEffect(file, exts)
	if !ok {
		return nil, false, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// effectRel folds a file token into a slash path under data/texture, constrained
// to that subtree. The token is interpreted relative to effect/; path.Clean folds
// any "../", and a result that climbs above data/texture (or is absolute) is
// rejected. Backslashes are normalized to forward slashes first.
func effectRel(file string) (string, bool) {
	file = strings.ReplaceAll(file, "\\", "/")
	if file == "" || strings.HasPrefix(file, "/") {
		return "", false
	}
	rel := path.Clean("effect/" + file)
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return "", false
	}
	return rel, true
}

func hasAnyExt(name string, exts []string) bool {
	low := strings.ToLower(name)
	for _, e := range exts {
		if e != "" && strings.HasSuffix(low, strings.ToLower(e)) {
			return true
		}
	}
	return false
}

// resolveCI walks a slash-separated path under s.base one segment at a time,
// resolving each segment case-insensitively, and returns the real absolute path
// if it names an existing file (not a directory).
func (s *Store) resolveCI(rel string) (string, bool) {
	cur := s.base
	segs := strings.Split(rel, "/")
	for i, seg := range segs {
		isLast := i == len(segs)-1
		// Fast path: exact hit (correct as-is, and the common case on a
		// case-insensitive host filesystem).
		cand := filepath.Join(cur, seg)
		if fi, err := os.Stat(cand); err == nil && (!isLast || !fi.IsDir()) {
			cur = cand
			continue
		}
		real, ok := s.lookup(cur, seg)
		if !ok {
			return "", false
		}
		cur = filepath.Join(cur, real)
	}
	if fi, err := os.Stat(cur); err != nil || fi.IsDir() {
		return "", false
	}
	return cur, true
}

// lookup finds the real casing of name within dir (case-insensitive), caching the
// directory's lowercased entry index on first use.
func (s *Store) lookup(dir, name string) (string, bool) {
	s.mu.Lock()
	idx, ok := s.dir[dir]
	s.mu.Unlock()
	if !ok {
		idx = map[string]string{}
		if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				idx[strings.ToLower(e.Name())] = e.Name()
			}
		}
		s.mu.Lock()
		s.dir[dir] = idx
		s.mu.Unlock()
	}
	real, ok := idx[strings.ToLower(name)]
	return real, ok
}
