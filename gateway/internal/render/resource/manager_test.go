package resource

import (
	"os"
	"path/filepath"
	"testing"
)

// resourcesRoot resolves the repo's resources/ dir (5 levels up from this package)
// and skips when it is absent (resources/ is gitignored).
func resourcesRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join("..", "..", "..", "..", "resources")
	if _, err := os.Stat(filepath.Join(root, "data")); err != nil {
		t.Skipf("resources not present: %v", err)
	}
	return root
}

func TestManagerLoadsRealBody(t *testing.T) {
	m := NewManager(resourcesRoot(t))
	const body = "인간족/몸통/남/검사_남"

	spr, err := m.Spr(body)
	if err != nil {
		t.Fatalf("Spr: %v", err)
	}
	if spr.ImageCount(0)+spr.ImageCount(1) == 0 {
		t.Error("body spr has no images")
	}
	act, err := m.Act(body)
	if err != nil {
		t.Fatalf("Act: %v", err)
	}
	if len(act.Actions) == 0 {
		t.Error("body act has no actions")
	}

	// Cache hit returns the same pointer.
	spr2, _ := m.Spr(body)
	if spr2 != spr {
		t.Error("expected cached spr pointer")
	}
}

func TestManagerNegativeCache(t *testing.T) {
	m := NewManager(resourcesRoot(t))
	const missing = "인간족/몸통/남/does_not_exist_xyz"
	if _, err := m.Spr(missing); err == nil {
		t.Fatal("expected error for missing spr")
	}
	if m.ExistsSpr(missing) {
		t.Error("ExistsSpr true for missing file")
	}
	// Second call should hit the negative cache (still an error).
	if _, err := m.Spr(missing); err == nil {
		t.Fatal("expected cached error for missing spr")
	}
}

func TestManagerExists(t *testing.T) {
	m := NewManager(resourcesRoot(t))
	if !m.ExistsSpr("인간족/몸통/남/검사_남") {
		t.Error("expected swordman body spr to exist")
	}
}
