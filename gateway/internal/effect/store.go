package effect

import (
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// Store resolves and reads raw assets out of one subtree of RESOURCE_DIR
// (data/texture for effects, data/model for models), case-insensitively. GRF
// paths are EUC-KR with inconsistent casing, and the extracted tree preserves
// whatever the client shipped; prod runs on a case-sensitive filesystem, so a
// lowercased directory index is kept per folder
// (built lazily, then cached — the resource tree is read-only between patches).
//
// That cache is why applying a patch must restart this process. The index is per
// folder and built once, so a patch that adds a file to a folder already indexed
// would 404 forever against a live process — not a cache miss but a permanent
// wrong answer. tools/patch-cycle.mjs restarts the gateway for this reason and
// for the parse caches in resource.Manager, which are keyed by name and equally
// blind to the file underneath changing.
//
// resolveCI cannot be replaced by a plain strings.ToLower. The LATAM client's
// tree happens to be entirely lowercase (24,624 texture files, no uppercase, no
// collisions), but extract-grf.mjs preserves whatever the GRF shipped —
// sanitizePath normalises separators and rejects traversal, it does not
// lowercase — so a self-hoster's client can legitimately produce mixed-case files
// that a lowercase lookup would fail to find, silently, as 404s.
// TestTextureTreeHasNoCaseCollisions pins that the mapping is injective.
type Store struct {
	base   string // the subtree a token is resolved inside, e.g. <resourceDir>/data/texture
	prefix string // folder under base a bare token is relative to ("effect", or "" for none)

	mu  sync.Mutex
	dir map[string]map[string]string // absDir -> lower(entryName) -> realEntryName
}

// NewStore roots a Store at the given resource directory (the one containing
// data/). Effect files live under data/texture/effect; the base is data/texture
// so the rare roBrowser "../npc/…" refs resolve to sibling texture folders while
// escapes above data/texture are rejected.
func NewStore(resourceDir string) *Store {
	return &Store{
		base:   filepath.Join(resourceDir, "data", "texture"),
		prefix: "effect",
		dir:    map[string]map[string]string{},
	}
}

// NewModelStore roots a Store at <resourceDir>/data/model, the client's .rsm /
// .rsm2 tree. Unlike the texture store there is no prefix folder: the client's
// model names are already relative to data/model ("외부소품\트랩01",
// "effect\deepblindtrap\deep_trap.rsm2"), which is also how the .rsw map files
// and the effect table's rsm rows spell them. With no prefix to climb out of,
// any "../" in a token is rejected outright rather than reaching a sibling tree.
func NewModelStore(resourceDir string) *Store {
	return &Store{
		base: filepath.Join(resourceDir, "data", "model"),
		dir:  map[string]map[string]string{},
	}
}

// Resolve maps a caller-supplied file token (relative to the store's prefix
// folder, and for the texture store may use "../" to reach a sibling texture
// folder) to a real on-disk path, trying each extension in exts in order. A
// candidate that already ends in one of exts (case-insensitively) is also tried
// verbatim. Returns "" if nothing resolves or the token escapes the store's
// base. The lookup is case-insensitive at every segment.
func (s *Store) Resolve(file string, exts []string) (string, bool) {
	rel, ok := s.rel(file)
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

// Read resolves and reads a file in one call, returning the resolved name
// alongside the bytes.
//
// The name is returned because callers need the extension — TextureToPNG decides
// between BMP and TGA from it — and a resolved *path* is not something an object
// store has. Returning the name keeps both backings answering the same question.
func (s *Store) Read(file string, exts []string) ([]byte, string, bool, error) {
	p, ok := s.Resolve(file, exts)
	if !ok {
		return nil, "", false, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, "", false, err
	}
	return data, p, true, nil
}

// rel folds a file token into a slash path under s.base, constrained to that
// subtree. The token is interpreted relative to s.prefix; path.Clean folds any
// "../", and a result that climbs above s.base (or is absolute) is rejected.
// Backslashes are normalized to forward slashes first — the client's own names
// are backslash-separated GRF paths and arrive that way.
func (s *Store) rel(file string) (string, bool) {
	file = strings.ReplaceAll(file, "\\", "/")
	if file == "" || strings.HasPrefix(file, "/") {
		return "", false
	}
	// Concatenating a "" prefix with "/" would make the token absolute, and
	// path.Clean would then swallow a leading "../" instead of exposing it to the
	// guard below — so a prefixless store cleans the token on its own.
	rel := file
	if s.prefix != "" {
		rel = s.prefix + "/" + file
	}
	rel = path.Clean(rel)
	if rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
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
