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
	if _, ok := s.ResolveEffect("stormgust", []string{".str"}); !ok {
		t.Error("stormgust (.str, lowercased) should resolve to StormGust.STR")
	}
	if _, ok := s.ResolveEffect("STORMGUST.str", []string{".str"}); !ok {
		t.Error("STORMGUST.str should resolve")
	}
	// Nested dir, mixed case, .bmp via ext list.
	if _, ok := s.ResolveEffect("stormcannon/sto", []string{".bmp", ".tga"}); !ok {
		t.Error("stormcannon/sto should resolve to StormCannon/sto.BMP")
	}
}

func TestResolveSiblingTextureFolder(t *testing.T) {
	s, _ := newTestStore(t)
	// roBrowser "../npc/…" refs reach a sibling texture folder, but stay under
	// data/texture.
	if _, ok := s.ResolveEffect("../npc/special", []string{".tga"}); !ok {
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
		if _, ok := s.ResolveEffect(bad, []string{".str"}); ok {
			t.Errorf("traversal %q should be rejected", bad)
		}
	}
}

func TestResolveMissing(t *testing.T) {
	s, _ := newTestStore(t)
	if _, ok := s.ResolveEffect("does_not_exist", []string{".str"}); ok {
		t.Error("missing file should not resolve")
	}
	// A directory name must not resolve as a file.
	if _, ok := s.ResolveEffect("stormcannon", []string{".str", ""}); ok {
		t.Error("a directory should not resolve as a file")
	}
}
