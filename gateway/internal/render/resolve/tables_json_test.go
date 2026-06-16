package resolve

import (
	"strings"
	"testing"

	"github.com/ragassets/zrenderer-gateway/internal/render/rotype"
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
