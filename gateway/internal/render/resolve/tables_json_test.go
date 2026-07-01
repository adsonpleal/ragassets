package resolve

import (
	"strings"
	"testing"

	"github.com/ragassets/gateway/internal/render/rotype"
)

func TestDefaultTablesLoads(t *testing.T) {
	tbl := DefaultTables()

	// Headgear 1230 (Floating Sage's Stone) — a known non-empty Korean accessory.
	if got := tbl.AccName(1230); got == "" {
		t.Error("AccName(1230) empty; generated tables not loaded?")
	}
	// Garment 245 resolves to the red pitaya basket (fixes the wrong-variant bug).
	if got := tbl.RobeSprName(245, false); got != "c_pitaya_r_bag" {
		t.Errorf("RobeSprName(245,false) = %q, want c_pitaya_r_bag", got)
	}
	// Lowercased.
	if got := tbl.JobName(1002); got != "poring" {
		t.Errorf("JobName(1002) = %q, want poring", got)
	}
	// Unknown ids return empty / identity.
	if got := tbl.AccName(0); got != "" {
		t.Errorf("AccName(0) = %q, want empty", got)
	}
	if got := tbl.RealWeaponID(999999); got != 999999 {
		t.Errorf("RealWeaponID identity = %d, want 999999", got)
	}
	// Unavailable client functions fall back to defaults.
	if tbl.ShadowFactor(1) != 1 {
		t.Error("ShadowFactor default should be 1")
	}
}

// TestHeadgearBehind checks the baked TB_Layer_Priority rule: the Sun God's
// Ornament (2669) draws behind the body for front/side-facing directions and in
// front when facing away; always-behind and unknown ids behave accordingly.
func TestHeadgearBehind(t *testing.T) {
	tbl := DefaultTables()

	// 2669: Default 304 with per-direction overrides -100 for 0,1,2,6,7.
	for _, d := range []int{0, 1, 2, 6, 7} {
		if behind, ok := tbl.HeadgearBehind(2669, d); !ok || !behind {
			t.Errorf("HeadgearBehind(2669, %d) = (%v,%v), want behind", d, behind, ok)
		}
	}
	for _, d := range []int{3, 4, 5} { // no override → falls back to Default 304 (front)
		if behind, ok := tbl.HeadgearBehind(2669, d); !ok || behind {
			t.Errorf("HeadgearBehind(2669, %d) = (%v,%v), want front", d, behind, ok)
		}
	}

	// 2803: Default -300, no overrides → behind in every direction.
	for d := 0; d < 8; d++ {
		if behind, ok := tbl.HeadgearBehind(2803, d); !ok || !behind {
			t.Errorf("HeadgearBehind(2803, %d) = (%v,%v), want behind", d, behind, ok)
		}
	}

	// Unknown id → no entry.
	if _, ok := tbl.HeadgearBehind(99999999, 0); ok {
		t.Error("HeadgearBehind(unknown) reported ok=true")
	}
}

// TestResolverWithRealTables exercises the resolver path builders against the
// generated tables for headgear/garment.
func TestResolverWithRealTables(t *testing.T) {
	r := New(DefaultTables())
	hg := r.HeadgearSprite(1230, rotype.Male)
	if !strings.HasPrefix(hg, "악세사리/남/남") {
		t.Errorf("headgear path = %q, want 악세사리/남/남...", hg)
	}
	gm := r.GarmentSprite(1, 245, rotype.Male, false, false)
	if gm != "로브/c_pitaya_r_bag/남/검사_남" {
		t.Errorf("garment path = %q", gm)
	}
}
