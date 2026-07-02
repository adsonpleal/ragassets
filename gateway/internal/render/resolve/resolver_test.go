package resolve

import (
	"testing"

	"github.com/ragassets/gateway/internal/render/rotype"
)

func TestPredicates(t *testing.T) {
	cases := []struct {
		name string
		fn   func(uint32) bool
		in   uint32
		want bool
	}{
		{"player novice", IsPlayer, 0, true},
		{"player swordman", IsPlayer, 1, true},
		{"player advanced", IsPlayer, 4001, true},
		{"player none", IsPlayer, NoJobID, true},
		{"not player monster", IsPlayer, 1002, false},
		{"monster poring", IsMonster, 1002, true},
		{"npc", IsNPC, 50, true},
		{"merc archer", IsMercenary, 6017, true},
		{"homun", IsHomunculus, 6001, true},
		{"doram", IsDoram, 4218, true},
		{"baby", IsBaby, 4023, true},
		{"madogear", IsMadogear, 4086, true},
		{"wereform", IsWereform, 4356, true},
	}
	for _, c := range cases {
		if got := c.fn(c.in); got != c.want {
			t.Errorf("%s(%d) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

func TestJobSpriteName(t *testing.T) {
	r := New(NopTables{})
	// Job 0 = novice (초보자), job 1 = swordman (검사).
	if got := r.JobSpriteName(0, rotype.MadogearRobot); got != "초보자" {
		t.Errorf("job 0 = %q, want 초보자", got)
	}
	if got := r.JobSpriteName(1, rotype.MadogearRobot); got != "검사" {
		t.Errorf("job 1 = %q, want 검사", got)
	}
	// Advanced job: 4001 -> index 51.
	if got := r.JobSpriteName(4001, rotype.MadogearRobot); got == "" {
		t.Error("advanced job 4001 resolved empty")
	}
}

func TestPlayerBodyAndHeadPaths(t *testing.T) {
	r := New(NopTables{})
	if got := r.PlayerBodySprite(1, rotype.Male, rotype.MadogearRobot); got != "인간족/몸통/남/검사_남" {
		t.Errorf("body = %q", got)
	}
	if got := r.PlayerBodySprite(1, rotype.Female, rotype.MadogearRobot); got != "인간족/몸통/여/검사_여" {
		t.Errorf("body female = %q", got)
	}
	if got := r.PlayerHeadSprite(1, 1, rotype.Male); got != "인간족/머리통/남/1_남" {
		t.Errorf("head = %q", got)
	}
}

func TestPalettePaths(t *testing.T) {
	r := New(NopTables{})
	if got := r.BodyPalette(1, 3, rotype.Male, rotype.MadogearRobot); got != "몸/검사_남_3" {
		t.Errorf("body palette = %q", got)
	}
	if got := r.HeadPalette(1, 2, 5, rotype.Male); got != "머리/머리2_남_5" {
		t.Errorf("head palette = %q", got)
	}
}

func TestHeadgearAndGarmentUseTables(t *testing.T) {
	r := New(fakeTables{})
	if got := r.HeadgearSprite(100, rotype.Male); got != "악세사리/남/남_testhat" {
		t.Errorf("headgear = %q", got)
	}
	if got := r.GarmentSprite(1, 200, rotype.Male, false, false); got != "로브/testrobe/남/검사_남" {
		t.Errorf("garment = %q", got)
	}
	if got := r.GarmentSprite(1, 200, rotype.Male, false, true); got != "로브/testrobe/testrobe" {
		t.Errorf("garment fallback = %q", got)
	}
	// Unknown id -> empty.
	if got := r.HeadgearSprite(999, rotype.Male); got != "" {
		t.Errorf("unknown headgear = %q, want empty", got)
	}
}

func TestGarmentCandidates(t *testing.T) {
	r := New(fakeTables{}) // RobeSprName(200) = "testrobe"
	got := r.GarmentCandidates(1, 200, rotype.Male)
	want := []string{
		"로브/testrobe/남/검사_남",          // classic per-job
		"로브/testrobe/testrobe/남/검사_남", // nested per-job
		"로브/testrobe/testrobe",        // shared single sprite
	}
	if len(got) != len(want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("candidate %d = %q, want %q", i, got[i], want[i])
		}
	}
	// Unknown garment → no candidates.
	if c := r.GarmentCandidates(1, 999, rotype.Male); len(c) != 0 {
		t.Errorf("unknown garment candidates = %v, want none", c)
	}
}

func TestShieldPath(t *testing.T) {
	r := New(NopTables{})
	// Shield id 0 maps to shield_names[0] (empty string suffix).
	got := r.ShieldSprite(1, 0, rotype.Male)
	if got == "" {
		t.Error("shield path empty")
	}
	// Out-of-range shield id falls back to the numeric form.
	got2 := r.ShieldSprite(1, 9999, rotype.Male)
	if got2 != "방패/검사/검사_남_9999_방패" {
		t.Errorf("shield fallback = %q", got2)
	}
}

func TestNonPlayerSprite(t *testing.T) {
	r := New(fakeTables{})
	// Monster poring (1002) -> 몬스터/<jobname>.
	if got := r.NonPlayerSprite(1002); got != "몬스터/poring" {
		t.Errorf("monster = %q", got)
	}
	// Players return empty.
	if got := r.NonPlayerSprite(1); got != "" {
		t.Errorf("player nonplayer = %q, want empty", got)
	}
	// Windhawk 4th-job companions are remapped to the effect-folder sprites
	// instead of the generic monster sprites jobname.lub points them at.
	if got := r.NonPlayerSprite(20830); got != "이팩트/windhawk_hawk" {
		t.Errorf("windhawk falcon = %q, want 이팩트/windhawk_hawk", got)
	}
	if got := r.NonPlayerSprite(20833); got != "이팩트/windhawk_wolf" {
		t.Errorf("windhawk warg = %q, want 이팩트/windhawk_wolf", got)
	}
}

// fakeTables provides deterministic client-table values for resolver tests.
type fakeTables struct{ NopTables }

func (fakeTables) AccName(id uint32) string {
	if id == 100 {
		return "_testhat"
	}
	return ""
}
func (fakeTables) RobeSprName(id uint32, english bool) string {
	if id == 200 {
		return "testrobe"
	}
	return ""
}
func (fakeTables) JobName(id uint32) string {
	if id == 1002 {
		return "poring"
	}
	return ""
}
