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

// TestManagerEvictsBeyondCap loads more sprite entries than the LRU cap and
// verifies the cache size stays bounded. Uses a tiny cap so we don't need a
// huge unique-name corpus.
func TestManagerEvictsBeyondCap(t *testing.T) {
	m := NewManagerWithLimits(resourcesRoot(t), 2, 2)

	// Three distinct names — the least-recently-used one should be evicted.
	names := []string{
		"인간족/몸통/남/검사_남",
		"인간족/몸통/여/검사_여",
		"인간족/머리통/남/1_남",
	}
	for _, n := range names {
		if _, err := m.Spr(n); err != nil {
			t.Fatalf("Spr(%s): %v", n, err)
		}
	}
	if got := m.spr.len(); got != 2 {
		t.Errorf("spr cache size = %d, want 2 (cap enforced)", got)
	}

	// The first name was evicted; re-loading it must not exceed the cap.
	if _, err := m.Spr(names[0]); err != nil {
		t.Fatalf("Spr reload: %v", err)
	}
	if got := m.spr.len(); got != 2 {
		t.Errorf("spr cache size after reload = %d, want 2", got)
	}
}
