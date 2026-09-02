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

// TestManagerStaysWithinBudget loads more sprite bytes than the cache budget and
// verifies the charged total stays bounded. The budget is bytes, not entries, so
// the invariant to assert is the byte total — how many entries happen to fit
// depends on the sizes of the sprites involved.
func TestManagerStaysWithinBudget(t *testing.T) {
	const budget = 256 << 10 // 256 KiB — smaller than the three sprites combined
	m := NewManagerWithBudget(resourcesRoot(t), budget, budget)

	names := []string{
		"인간족/몸통/남/검사_남", // ~194 KiB
		"인간족/몸통/여/검사_여", // ~198 KiB
		"인간족/머리통/남/1_남", //  ~ 8 KiB
	}
	for _, n := range names {
		if _, err := m.Spr(n); err != nil {
			t.Fatalf("Spr(%s): %v", n, err)
		}
	}
	if got := m.spr.bytes(); got > budget {
		t.Errorf("spr cache = %d bytes, over budget %d", got, budget)
	}
	if m.spr.len() == 0 {
		t.Error("cache evicted everything; budget should hold at least one sprite")
	}

	// Re-loading an evicted name must not push the cache over budget either.
	if _, err := m.Spr(names[0]); err != nil {
		t.Fatalf("Spr reload: %v", err)
	}
	if got := m.spr.bytes(); got > budget {
		t.Errorf("spr cache after reload = %d bytes, over budget %d", got, budget)
	}
}

// TestManagerDoesNotRetainOversized checks the per-entry ceiling: a sprite larger
// than maxEntryBytes is still parsed and returned, but must not be kept, so one
// huge monster cannot evict the whole hot set behind it.
func TestManagerDoesNotRetainOversized(t *testing.T) {
	root := resourcesRoot(t)
	const huge = "몬스터/firepit" // 19.5 MB — the largest .spr in the library
	m := NewManagerWithBudget(root, DefaultSprCacheBytes, DefaultActCacheBytes)

	if _, err := m.Spr(huge); err != nil {
		t.Skipf("%s not extracted: %v", huge, err)
	}
	if got := m.spr.len(); got != 0 {
		t.Errorf("oversized sprite was retained (%d entries); it should be served, not cached", got)
	}
	if got := m.spr.bytes(); got != 0 {
		t.Errorf("oversized sprite charged %d bytes against the budget", got)
	}
}
