package skin

import "testing"

// TestTableInvariants checks the committed bake, which is what actually ships.
// The generator has no test of its own (matching cmd/gen-resolver); these
// assertions on its output are the safety net.
func TestTableInvariants(t *testing.T) {
	bodies, heads := Counts()
	if bodies < 500 {
		t.Errorf("only %d body sprites in the table; expected the whole player set (~540)", bodies)
	}
	if heads != 84 {
		t.Errorf("%d head sprites in the table, want 84 (42 per gender)", heads)
	}

	positions := map[int]int{}
	multi := 0
	for path, slots := range bodyTable {
		checkSlots(t, "body "+path, slots)
		positions[slots[0].Index]++
		if len(slots) > 8 {
			multi++
		}
	}
	if len(positions) < 2 {
		t.Error("every body starts its skin at the same index; per-sprite detection is not doing anything")
	}
	// Sprites really do carry skin at more than one palette position; a bake that
	// finds none of them has regressed to picking a single range.
	if multi < 10 {
		t.Errorf("only %d bodies carry skin at more than one position; expected ~50", multi)
	}

	totalPx, totalRuns := 0, 0
	for path, ent := range headTable {
		checkSlots(t, "head "+path, ent.Skin)
		skinIdx := map[int]bool{}
		for _, s := range ent.Skin {
			skinIdx[s.Index] = true
		}
		for img, runs := range ent.Px {
			if img < 0 {
				t.Errorf("head %s: negative image index %d", path, img)
			}
			for _, r := range runs {
				totalRuns++
				totalPx += len(r.Offsets)
				if len(r.Offsets) == 0 {
					t.Errorf("head %s image %d: empty run", path, img)
				}
				// A run whose source index is itself skin would be recoloured twice,
				// once by the palette and once by the override.
				if skinIdx[r.SrcIndex] {
					t.Errorf("head %s image %d: run source index %d is skin", path, img, r.SrcIndex)
				}
				for _, o := range r.Offsets {
					if o < 0 {
						t.Errorf("head %s image %d: negative offset %d", path, img, o)
					}
				}
				if r.Pos < -1 || r.Pos > 2.5 {
					t.Errorf("head %s image %d: implausible ramp position %.3f (index %d)", path, img, r.Pos, r.SrcIndex)
				}
			}
		}
	}
	if totalPx < 900 || totalPx > 3600 {
		t.Errorf("face-lighting pixels = %d, expected roughly 1800; re-review the generator's sheets", totalPx)
	}
	t.Logf("table: %d bodies (%d multi-position), %d heads, %d runs, %d face-lighting pixels",
		bodies, multi, heads, totalRuns, totalPx)
}

func checkSlots(t *testing.T, what string, slots []SlotIndex) {
	t.Helper()
	if len(slots) == 0 {
		t.Errorf("%s: no skin indices", what)
		return
	}
	seen := map[int]bool{}
	for _, s := range slots {
		if s.Index < 1 || s.Index > 255 {
			t.Errorf("%s: palette index %d out of range", what, s.Index)
		}
		if s.Slot < 0 || s.Slot >= len(BaseRamp) {
			t.Errorf("%s: ramp slot %d out of range", what, s.Slot)
		}
		if seen[s.Index] {
			t.Errorf("%s: palette index %d appears twice", what, s.Index)
		}
		seen[s.Index] = true
	}
}

// TestKnownSkinPositions pins sprites whose layout was established by hand. The
// costume entry is the guard against regressing to a fixed palette range; the
// 타조원더러 entry is the guard against picking only one of two skin blocks.
func TestKnownSkinPositions(t *testing.T) {
	firstRun := func(path string) []int {
		t.Helper()
		slots, ok := Body(path)
		if !ok {
			t.Errorf("%s missing from the table", path)
			return nil
		}
		var out []int
		for _, s := range slots {
			out = append(out, s.Index)
		}
		return out
	}

	if got := firstRun("인간족/몸통/여/원더러_여"); len(got) != 8 || got[0] != 48 {
		t.Errorf("Wanderer body skin = %v, want 48-55", got)
	}
	if got := firstRun("인간족/몸통/여/costume_1/원더러_여_1"); len(got) != 8 || got[0] != 43 {
		t.Errorf("Wanderer costume_1 skin = %v, want 43-50", got)
	}
	// Two separate blocks of skin: 48-55 and 240-247.
	if got := firstRun("인간족/몸통/여/타조원더러_여"); len(got) != 16 {
		t.Errorf("ostrich Wanderer skin = %v, want 16 indices across two blocks", got)
	}
	// No eight-long run exists here — the sprite never uses the lightest highlight.
	if got := firstRun("인간족/몸통/남/costume_1/미케닉_남_1"); len(got) != 7 {
		t.Errorf("Mechanic costume_1 skin = %v, want 7 indices (slot 0 unused)", got)
	}

	// Every head uses the canonical 128-135.
	for path, ent := range headTable {
		if len(ent.Skin) != 8 {
			t.Errorf("head %s has %d skin indices, want 8", path, len(ent.Skin))
			continue
		}
		for i, s := range ent.Skin {
			if s.Index != 128+i || s.Slot != i {
				t.Errorf("head %s skin = %v, want 128-135 in order", path, ent.Skin)
				break
			}
		}
	}
}
