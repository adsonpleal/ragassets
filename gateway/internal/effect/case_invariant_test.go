package effect

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The migration to an object store cannot keep resolveCI: R2 offers no ReadDir
// and no cheap Stat, so case-insensitive resolution has to become a plain
// lowercase key lookup, with every key normalised at upload time.
//
// That substitution is only sound while lowercasing is injective over the tree —
// two files differing solely in case would collide into one object and one would
// be lost. This test pins that invariant so it is checked against the real client
// rather than assumed.
//
// It deliberately does NOT assert the tree is already all-lowercase. It happens
// to be, for this client, but extract-grf.mjs preserves whatever casing the GRF
// shipped (sanitizePath normalises separators only), so a different client can
// legitimately produce mixed-case files. That is exactly why resolveCI still
// exists for filesystem-backed stores and must not be deleted on the strength of
// one client's data.
func TestTextureTreeHasNoCaseCollisions(t *testing.T) {
	root := filepath.Join("..", "..", "..", "resources", "data", "texture")
	if _, err := os.Stat(root); err != nil {
		t.Skipf("resources not present: %v", err)
	}

	seen := make(map[string]string, 32768)
	var files int
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		files++
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		key := strings.ToLower(filepath.ToSlash(rel))
		if prev, dup := seen[key]; dup {
			t.Errorf("case collision: %q and %q both lowercase to %q — "+
				"they would overwrite each other as object keys", prev, filepath.ToSlash(rel), key)
			return nil
		}
		seen[key] = filepath.ToSlash(rel)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	if files == 0 {
		t.Fatal("walked the texture tree and found no files")
	}
	t.Logf("%d texture files, %d distinct lowercase keys", files, len(seen))
}
