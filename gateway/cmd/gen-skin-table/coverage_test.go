package main

import (
	"fmt"
	"os"
	"sort"
	"testing"

	"github.com/ragassets/gateway/internal/render/resource"
	"github.com/ragassets/gateway/internal/render/roformat"
	"github.com/ragassets/gateway/internal/render/skin"
)

const resRoot = "../../../resources"

// TestBakeCoversEveryDrawnSkinIndex is the completeness check for the committed
// table, and the only rigorous one available.
//
// Checking rendered pixels instead does not work: a clothes dye can paint a
// non-skin palette index a colour that exactly matches a skin colour (dye
// 몸/검사_여_2 sets index 16 to f7f0e5 on a garment), and such a pixel is
// indistinguishable from genuinely-missed skin once it is a colour rather than an
// index. So the assertion is made where the truth actually lives — every palette
// index that carries a canonical skin colour and is actually drawn must be in the
// table.
func TestBakeCoversEveryDrawnSkinIndex(t *testing.T) {
	if _, err := os.Stat(resRoot + "/data"); err != nil {
		t.Skipf("resources not present: %v", err)
	}
	mgr := resource.NewManager(resRoot)

	type miss struct {
		sprite string
		index  int
		slot   int
		px     int
		dye    string
	}
	var misses []miss
	sprites, drawnTotal := 0, 0

	check := func(name string, baked map[int]bool) {
		spr, err := mgr.Spr(name)
		if err != nil {
			return
		}
		sprites++

		drawn := map[int]int{}
		for img := 0; img < spr.ImageCount(0); img++ {
			idx, _, _ := spr.DecodeIndices(img)
			for _, v := range idx {
				if v != 0 {
					drawn[int(v)]++
				}
			}
		}
		drawnTotal += len(drawn)

		// Only the sprite's own palette decides what is skin. A dye that happens to
		// paint a garment index a flesh colour is painting a garment, and recolouring
		// it would tint clothing; real skin is skin-coloured in the embedded palette
		// too, in every sprite examined.
		pals := map[string]roformat.Palette{"": spr.Palette()}
		for dyeName, pal := range pals {
			for i, n := range drawn {
				if baked[i] || i >= len(pal) {
					continue
				}
				for slot, want := range skin.BaseRamp {
					if nearlyEqual(pal[i], want) {
						misses = append(misses, miss{name, i, slot, n, dyeName})
						break
					}
				}
			}
		}
	}

	for _, g := range []string{"여", "남"} {
		names, err := walkSprites(resRoot, humanRace+"/"+bodyDir+"/"+g)
		if err != nil {
			t.Fatalf("walk bodies: %v", err)
		}
		for _, name := range names {
			baked := map[int]bool{}
			if slots, ok := skin.Body(name); ok {
				for _, s := range slots {
					baked[s.Index] = true
				}
			}
			check(name, baked)
		}
		names, err = walkSprites(resRoot, humanRace+"/"+headDir+"/"+g)
		if err != nil {
			t.Fatalf("walk heads: %v", err)
		}
		for _, name := range names {
			baked := map[int]bool{}
			if ent, ok := skin.Head(name); ok {
				for _, s := range ent.Skin {
					baked[s.Index] = true
				}
			}
			check(name, baked)
		}
	}

	t.Logf("checked %d sprites, %d drawn palette indices", sprites, drawnTotal)
	if len(misses) == 0 {
		return
	}

	// Collapse to one line per sprite+index; a miss usually shows up under several dyes.
	uniq := map[string]miss{}
	for _, m := range misses {
		k := fmt.Sprintf("%s#%d", m.sprite, m.index)
		if _, ok := uniq[k]; !ok {
			uniq[k] = m
		}
	}
	keys := make([]string, 0, len(uniq))
	for k := range uniq {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	// An uncovered index is only acceptable if the generator would deliberately
	// reject it: isolated (no run of consecutive ramp slots around it) and never
	// drawn touching confirmed skin. Every such case reviewed so far is the mount's
	// own colouring — a poring's body, a toad's belly — which must not be recoloured.
	var real []string
	deliberate := 0
	for _, k := range keys {
		m := uniq[k]
		spr, err := mgr.Spr(m.sprite)
		if err != nil {
			continue
		}
		baked := map[int]int{}
		if slots, ok := skin.Body(m.sprite); ok {
			for _, s := range slots {
				baked[s.Index] = s.Slot
			}
		} else if ent, ok := skin.Head(m.sprite); ok {
			for _, s := range ent.Skin {
				baked[s.Index] = s.Slot
			}
		}
		if touchesAccepted(spr, byte(m.index), baked) {
			real = append(real, fmt.Sprintf("%s index %d (slot %d, %d px) touches confirmed skin but is not baked",
				m.sprite, m.index, m.slot, m.px))
			continue
		}
		deliberate++
	}
	t.Logf("%d uncovered indices, all isolated from confirmed skin (mount/creature colouring, deliberately left alone)", deliberate)
	if deliberate > 40 {
		t.Errorf("%d deliberate exclusions is more than expected (~23); re-review them", deliberate)
	}
	for _, r := range real {
		t.Error(r)
	}
}
