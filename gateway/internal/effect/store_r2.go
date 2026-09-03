//go:build js && wasm

package effect

import "strings"

// ObjectStore resolves effect assets from an object store instead of a
// filesystem, for the Worker build.
//
// It shares the path folding with Store — effectRel constrains a caller token to
// the data/texture subtree and collapses any "../" — and differs in exactly one
// place: resolution. Store walks each path segment case-insensitively because the
// extracted tree preserves whatever casing the client shipped, and that needs
// ReadDir, which an object store has no cheap equivalent of.
//
// Here a candidate is lowercased and fetched directly. That substitution is only
// sound while lowercasing is injective over the tree, which
// TestTextureTreeHasNoCaseCollisions pins: 24,624 texture files, no uppercase, no
// collisions. The mixed case that does occur is in the caller's token —
// /effect/texture?file=StormGust — which lowercasing handles.
//
// If a client ever ships genuinely mixed-case texture files, that test fails
// first, and the fix is an upload-time lowercase-to-real key index rather than a
// change here.
type ObjectStore struct {
	// Get returns the bytes for a key relative to the resource root, e.g.
	// "data/texture/effect/foo.bmp". A missing key must return an error.
	Get func(key string) ([]byte, error)
}

// NewObjectStore builds a store over a key reader.
func NewObjectStore(get func(key string) ([]byte, error)) *ObjectStore {
	return &ObjectStore{Get: get}
}

// Read resolves a caller token against the object store and returns the bytes
// with the resolved name, matching Store.Read's contract so both backings answer
// the same question the same way.
func (s *ObjectStore) Read(file string, exts []string) ([]byte, string, bool, error) {
	rel, ok := effectRel(file)
	if !ok {
		return nil, "", false, nil
	}

	// A token that already carries an accepted extension is tried verbatim first,
	// mirroring Store.ResolveEffect.
	var candidates []string
	if hasAnyExt(rel, exts) {
		candidates = append(candidates, rel)
	}
	for _, ext := range exts {
		candidates = append(candidates, rel+ext)
	}

	for _, c := range candidates {
		key := "data/texture/" + strings.ToLower(c)
		b, err := s.Get(key)
		if err != nil {
			continue // absent: try the next extension
		}
		return b, c, true, nil
	}
	return nil, "", false, nil
}
