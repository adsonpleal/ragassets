package effect

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Lowercasing must stay injective over the texture tree: two files differing
// solely in case would collide into one key, and one of them would be lost by
// anything that addresses this tree case-insensitively. This test pins that
// invariant against the real client rather than assuming it.
//
// It was written for a migration that no longer exists — serving these files out
// of an R2 bucket, which has no ReadDir and no cheap Stat and so would have had
// to replace resolveCI with a flat lowercase key lookup. That path was deleted
// with the Worker on 2026-09-08. The invariant outlived it: any store keyed by a
// normalised name has the same collision, and so does a case-insensitive
// filesystem, which is what a Windows development box is.
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
