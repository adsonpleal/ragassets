package effect

import (
	"os"
	"path/filepath"
	"testing"
)

// newTestStore lays out a minimal <root>/data/texture tree and returns a Store.
func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	eff := filepath.Join(root, "data", "texture", "effect")
	if err := os.MkdirAll(filepath.Join(eff, "StormCannon"), 0o755); err != nil {
		t.Fatal(err)
	}
	npc := filepath.Join(root, "data", "texture", "npc")
	if err := os.MkdirAll(npc, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(p string) {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(eff, "StormGust.STR")) // odd casing
	write(filepath.Join(eff, "StormCannon", "sto.BMP"))
	write(filepath.Join(npc, "special.tga"))
	return NewStore(root), root
}

func TestResolveCaseInsensitive(t *testing.T) {
	s, _ := newTestStore(t)
	// Wrong case + missing extension both resolve.
	if _, ok := s.Resolve("stormgust", []string{".str"}); !ok {
		t.Error("stormgust (.str, lowercased) should resolve to StormGust.STR")
	}
	if _, ok := s.Resolve("STORMGUST.str", []string{".str"}); !ok {
		t.Error("STORMGUST.str should resolve")
	}
	// Nested dir, mixed case, .bmp via ext list.
	if _, ok := s.Resolve("stormcannon/sto", []string{".bmp", ".tga"}); !ok {
		t.Error("stormcannon/sto should resolve to StormCannon/sto.BMP")
	}
}

func TestResolveSiblingTextureFolder(t *testing.T) {
	s, _ := newTestStore(t)
	// roBrowser "../npc/…" refs reach a sibling texture folder, but stay under
	// data/texture.
	if _, ok := s.Resolve("../npc/special", []string{".tga"}); !ok {
		t.Error("../npc/special should resolve under data/texture/npc")
	}
}

func TestResolveRejectsTraversal(t *testing.T) {
	s, root := newTestStore(t)
	// A secret sitting above data/texture must be unreachable.
	if err := os.WriteFile(filepath.Join(root, "secret.str"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"../../secret",        // climbs above data/texture
		"../../../etc/passwd", // absolute-ish escape
		"/etc/passwd",         // leading slash
		"..",                  // bare parent
	} {
		if _, ok := s.Resolve(bad, []string{".str"}); ok {
			t.Errorf("traversal %q should be rejected", bad)
		}
	}
}

func TestResolveMissing(t *testing.T) {
	s, _ := newTestStore(t)
	if _, ok := s.Resolve("does_not_exist", []string{".str"}); ok {
		t.Error("missing file should not resolve")
	}
	// A directory name must not resolve as a file.
	if _, ok := s.Resolve("stormcannon", []string{".str", ""}); ok {
		t.Error("a directory should not resolve as a file")
	}
}

// newTestModelStore lays out a minimal <root>/data/model tree, with the two
// shapes the client's own model names come in: a Korean, backslash-separated
// name with no extension (the classic trap props) and an ASCII name that spells
// its .rsm2 suffix out (the 4th-job ones).
func newTestModelStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	write := func(parts ...string) {
		p := filepath.Join(append([]string{root, "data", "model"}, parts...)...)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("GRSM\x01\x04"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("외부소품", "트랩01.rsm")
	write("event", "3차트랩_가시01.rsm")
	write("effect", "deepblindtrap", "deep_trap.rsm2")
	write("Mixed", "Case01.RSM") // a client that shipped its own casing
	return NewModelStore(root), root
}

func TestModelResolve(t *testing.T) {
	s, _ := newTestModelStore(t)
	for _, tc := range []struct{ name, token string }{
		{"korean, backslashes, no extension", `외부소품\트랩01`},
		{"korean, forward slashes", "외부소품/트랩01"},
		{"korean, extension spelled out", `외부소품\트랩01.rsm`},
		{"korean under event/", `event\3차트랩_가시01`},
		{"ascii .rsm2 spelled out", `effect\deepblindtrap\deep_trap.rsm2`},
		{"ascii .rsm2 omitted", `effect\deepblindtrap\deep_trap`},
		{"mixed case folded", `mixed\case01`},
	} {
		if _, ok := s.Resolve(tc.token, ModelExts); !ok {
			t.Errorf("%s: %q should resolve", tc.name, tc.token)
		}
	}
}

// A model store has no prefix folder to climb out of, so every "../" is an
// escape attempt rather than a sibling-tree reference.
func TestModelResolveRejectsTraversal(t *testing.T) {
	s, root := newTestModelStore(t)
	if err := os.WriteFile(filepath.Join(root, "data", "secret.rsm"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"../secret",         // one level up is already out
		`..\secret`,         // the same, backslashed
		"../../etc/passwd",  // further up
		"/etc/passwd",       // absolute
		"..",                // bare parent
		"외부소품/../../secret", // climbs back out after descending
	} {
		if p, ok := s.Resolve(bad, ModelExts); ok {
			t.Errorf("traversal %q should be rejected, resolved to %q", bad, p)
		}
	}
}

func TestModelResolveMissing(t *testing.T) {
	s, _ := newTestModelStore(t)
	if _, ok := s.Resolve("외부소품/트랩99", ModelExts); ok {
		t.Error("a model the client never shipped should not resolve")
	}
	// A directory must not resolve as a file, with or without an extension.
	if _, ok := s.Resolve("외부소품", ModelExts); ok {
		t.Error("a directory should not resolve as a model")
	}
}
