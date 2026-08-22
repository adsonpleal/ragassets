package engine

import (
	"testing"

	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/rotype"
)

func renderStill(t *testing.T, e *Engine, mutate func(*Request)) raster.RawImage {
	t.Helper()
	req := baseReq()
	req.Frame = 0
	mutate(&req)
	res, err := e.Render(req)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if len(res.Frames) == 0 {
		t.Fatal("render produced no frames")
	}
	return res.Frames[0]
}

func diffPixels(a, b raster.RawImage) int {
	if a.Width != b.Width || a.Height != b.Height {
		return -1
	}
	n := 0
	for i := range a.Pixels {
		if a.Pixels[i] != b.Pixels[i] {
			n++
		}
	}
	return n
}

// TestSkinIdentityIsByteIdentical is the guarantee that adding this feature
// changed nothing for every existing caller.
func TestSkinIdentityIsByteIdentical(t *testing.T) {
	e := newEngine(t)
	unset := renderStill(t, e, func(r *Request) {})
	one := renderStill(t, e, func(r *Request) { r.SkinTone = 1 })
	if !framesEqual(unset, one) {
		t.Error("skinTone=1 differs from no skin param; the identity tone must be a no-op")
	}
}

func TestSkinToneChangesSkinOnly(t *testing.T) {
	e := newEngine(t)
	base := renderStill(t, e, func(r *Request) { r.SkinTone = 1 })
	for _, tone := range []int{2, 3, 4} {
		got := renderStill(t, e, func(r *Request) { r.SkinTone = tone })
		d := diffPixels(base, got)
		if d <= 0 {
			t.Errorf("skinTone=%d changed %d pixels, want some", tone, d)
			continue
		}
		if opaqueCount(got) != opaqueCount(base) {
			t.Errorf("skinTone=%d changed the silhouette (%d opaque vs %d)", tone, opaqueCount(got), opaqueCount(base))
		}
	}
	// Darker tones should move more pixels away from the original than lighter ones.
	d2 := diffPixels(base, renderStill(t, e, func(r *Request) { r.SkinTone = 2 }))
	d4 := diffPixels(base, renderStill(t, e, func(r *Request) { r.SkinTone = 4 }))
	if d4 < d2 {
		t.Errorf("tone 4 changed fewer pixels (%d) than tone 2 (%d)", d4, d2)
	}
}

// TestSkinToneAltCostume is the regression guard for the discovery that a
// costume body keeps its skin ramp at a different palette position (43-50 for
// the Wanderer's costume_1, against 48-55 on her default body). A build that
// assumed a fixed range would render this one unchanged.
func TestSkinToneAltCostume(t *testing.T) {
	e := newEngine(t)
	set := func(outfit uint32, tone int) Request {
		r := baseReq()
		r.Job = 4069 // Wanderer
		r.Gender = rotype.Female
		r.Outfit = outfit
		r.SkinTone = tone
		r.Frame = 0
		return r
	}
	for _, outfit := range []uint32{0, 1} {
		one, err := e.Render(set(outfit, 1))
		if err != nil {
			t.Fatalf("outfit %d tone 1: %v", outfit, err)
		}
		four, err := e.Render(set(outfit, 4))
		if err != nil {
			t.Fatalf("outfit %d tone 4: %v", outfit, err)
		}
		d := diffPixels(one.Frames[0], four.Frames[0])
		if d < 50 {
			t.Errorf("outfit %d: only %d pixels changed; the skin ramp was probably not found", outfit, d)
		}
	}
}

// TestSkinToneSurvivesClothesDye: the skin ramp indices are proven dye-invariant
// at bake time, so a tone must land the same way whichever dye is applied.
func TestSkinToneSurvivesClothesDye(t *testing.T) {
	e := newEngine(t)
	var counts []int
	for dye := 0; dye < 8; dye++ {
		r := baseReq()
		r.Job = 4069
		r.Gender = rotype.Female
		r.Frame = 0
		r.BodyPalette = dye

		r.SkinTone = 1
		plain, err := e.Render(r)
		if err != nil {
			t.Fatalf("dye %d: %v", dye, err)
		}
		r.SkinTone = 4
		toned, err := e.Render(r)
		if err != nil {
			t.Fatalf("dye %d: %v", dye, err)
		}
		counts = append(counts, diffPixels(plain.Frames[0], toned.Frames[0]))
	}
	for i, n := range counts {
		if n != counts[0] {
			t.Errorf("dye %d changed %d skin pixels, dye 0 changed %d; the ramp is not dye-independent",
				i, n, counts[0])
		}
	}
	t.Logf("skin pixels recoloured per clothes dye: %v", counts)
}

// TestSkinToneAcrossActionsAndDirections is the cheap proof of the claim that a
// palette-level recolour covers every animation: nothing here is per-action.
func TestSkinToneAcrossActionsAndDirections(t *testing.T) {
	e := newEngine(t)
	// stand, move, sit, attack, damage, dead — one direction each, plus a couple
	// of directions of stand.
	for _, action := range []uint{0, 2, 8, 16, 40, 48, 64} {
		r := baseReq()
		r.Action = action
		r.Frame = -1
		r.SkinTone = 1
		plain, err := e.Render(r)
		if err != nil {
			t.Fatalf("action %d: %v", action, err)
		}
		r.SkinTone = 4
		toned, err := e.Render(r)
		if err != nil {
			t.Fatalf("action %d: %v", action, err)
		}
		if len(plain.Frames) != len(toned.Frames) {
			t.Fatalf("action %d: frame count changed (%d vs %d)", action, len(plain.Frames), len(toned.Frames))
		}
		for i := range plain.Frames {
			if framesEqual(plain.Frames[i], toned.Frames[i]) {
				t.Errorf("action %d frame %d was not recoloured", action, i)
			}
		}
	}
}

func TestSkinToneIgnoredForDoram(t *testing.T) {
	e := newEngine(t)
	set := func(tone int) Request {
		r := baseReq()
		r.Job = 4218 // Summoner (doram)
		r.Gender = rotype.Female
		r.Frame = 0
		r.SkinTone = tone
		return r
	}
	one, err := e.Render(set(1))
	if err != nil {
		t.Skipf("doram sprites not extracted: %v", err)
	}
	four, err := e.Render(set(4))
	if err != nil {
		t.Fatalf("doram tone 4: %v", err)
	}
	if !framesEqual(one.Frames[0], four.Frames[0]) {
		t.Error("doram render changed with a skin tone; doram is out of scope")
	}
}

func TestSkinCustomColor(t *testing.T) {
	e := newEngine(t)
	base := renderStill(t, e, func(r *Request) { r.SkinTone = 1 })

	brown := raster.Color{R: 0x8a, G: 0x5a, B: 0x3b, A: 255}
	custom := renderStill(t, e, func(r *Request) { r.SkinColor = &brown })
	if diffPixels(base, custom) <= 0 {
		t.Error("custom skin colour changed nothing")
	}
	if opaqueCount(custom) != opaqueCount(base) {
		t.Error("custom skin colour changed the silhouette")
	}

	// SkinColor must win over SkinTone rather than being merged with it.
	both := renderStill(t, e, func(r *Request) { r.SkinTone = 2; r.SkinColor = &brown })
	if !framesEqual(custom, both) {
		t.Error("SkinColor should supersede SkinTone")
	}

	// Passing the ramp's own midtone should leave the sprite near-identical.
	mid := raster.Color{R: 0xf6, G: 0xae, B: 0x9f, A: 255}
	same := renderStill(t, e, func(r *Request) { r.SkinColor = &mid })
	if d := diffPixels(base, same); d > opaqueCount(base)/4 {
		t.Errorf("passing the base midtone changed %d of %d pixels; expected a near no-op",
			d, opaqueCount(base))
	}
}
