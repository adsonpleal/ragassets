package engine

import (
	"fmt"
	"os"
	"sort"
	"testing"

	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/rotype"
	"github.com/ragassets/gateway/internal/render/skin"
)

// A library-wide smoke test: every player job, gender and outfit renders at both
// tones, keeps its silhouette, and actually changes where the sprite has skin.
//
// It deliberately does NOT assert "no base-ramp colour survives". Compositing —
// a layer tint, or the 0.75 resample applied to baby classes — can land on a skin
// colour by coincidence, and once a pixel is a colour rather than a palette index
// that is indistinguishable from genuinely-missed skin. Completeness is asserted
// where the truth lives instead, against palette indices, in
// cmd/gen-skin-table's TestBakeCoversEveryDrawnSkinIndex.
//
// Runs a sampled sweep by default; set SKIN_SWEEP=full for every job id.

func baseRampSet() map[raster.Color]bool {
	m := make(map[raster.Color]bool, len(skin.BaseRamp))
	for _, c := range skin.BaseRamp {
		m[c] = true
	}
	return m
}

// countSkin reports how many opaque pixels carry an original skin-ramp colour.
func countSkin(im raster.RawImage, ramp map[raster.Color]bool) int {
	n := 0
	for _, p := range im.Pixels {
		if p.A == 0xFF && ramp[p] {
			n++
		}
	}
	return n
}

type sweepCase struct {
	job    uint32
	gender rotype.Gender
	outfit uint32
	mado   rotype.MadogearType
	head   uint32
	dir    uint
}

func (c sweepCase) String() string {
	g := "f"
	if c.gender == rotype.Male {
		g = "m"
	}
	return fmt.Sprintf("job=%d/%s/outfit=%d/mado=%d/head=%d/dir=%d", c.job, g, c.outfit, int(c.mado), c.head, c.dir)
}

type sweepResult struct {
	rendered, withSkin, noSkin int
	failures                   []string
}

func runSweep(t *testing.T, e *Engine, cases []sweepCase) sweepResult {
	t.Helper()
	ramp := baseRampSet()
	var res sweepResult

	// A combination counts as recoloured if ANY of its sampled directions changed:
	// a sprite can be fully armoured from one angle and bare from another.
	type combo struct {
		job    uint32
		gender rotype.Gender
		outfit uint32
		mado   rotype.MadogearType
		head   uint32
	}
	hadSkin := map[combo]bool{}
	changed := map[combo]bool{}

	for _, c := range cases {
		req := Request{
			Job: c.job, Gender: c.gender, Head: c.head, Outfit: c.outfit,
			Action: c.dir, Frame: 0, BodyPalette: -1, HeadPalette: -1,
			HeadDir: rotype.All, Madogear: c.mado, EnableShadow: false,
		}
		req.SkinTone = 1
		plain, err := e.Render(req)
		if err != nil || len(plain.Frames) == 0 {
			continue // job/costume combination does not resolve; not a skin problem
		}
		req.SkinTone = skin.PresetCount
		toned, err := e.Render(req)
		if err != nil || len(toned.Frames) == 0 {
			res.failures = append(res.failures, c.String()+": renders at tone 1 but fails at tone 4")
			continue
		}
		res.rendered++

		if a, b := plain.Frames[0], toned.Frames[0]; a.Width != b.Width || a.Height != b.Height {
			res.failures = append(res.failures, c.String()+": the tone changed the frame size")
			continue
		}
		if opaqueCount(plain.Frames[0]) != opaqueCount(toned.Frames[0]) {
			res.failures = append(res.failures, c.String()+": the tone changed the silhouette")
			continue
		}
		// A tone must never introduce skin colours that were not there before.
		if before, after := countSkin(plain.Frames[0], ramp), countSkin(toned.Frames[0], ramp); after > before {
			res.failures = append(res.failures,
				fmt.Sprintf("%s: skin-coloured pixels rose from %d to %d", c, before, after))
			continue
		}

		k := combo{c.job, c.gender, c.outfit, c.mado, c.head}
		if countSkin(plain.Frames[0], ramp) > 0 {
			hadSkin[k] = true
		}
		if !framesEqual(plain.Frames[0], toned.Frames[0]) {
			changed[k] = true
		}
	}

	for k := range hadSkin {
		if changed[k] {
			res.withSkin++
			continue
		}
		res.noSkin++
		res.failures = append(res.failures,
			fmt.Sprintf("job=%d gender=%v outfit=%d head=%d: shows skin colours but no direction recoloured",
				k.job, k.gender, k.outfit, k.head))
	}
	return res
}

func playerJobs() []uint32 {
	var out []uint32
	for id := uint32(0); id < 45; id++ {
		out = append(out, id)
	}
	for id := uint32(4001); id <= 4360; id++ {
		out = append(out, id)
	}
	return out
}

// TestSkinSweepAllBodies covers every player body sprite reachable from a job id —
// which is how mounts, madogear and alternate costumes get covered, since they are
// all just different job ids or outfit numbers rather than special cases.
func TestSkinSweepAllBodies(t *testing.T) {
	e := newEngine(t)

	jobs := playerJobs()
	dirs := []uint{0, 2, 4}
	if os.Getenv("SKIN_SWEEP") != "full" {
		// Sampled: every 3rd advanced job, all of the classic ones. Still ~150 jobs.
		var sampled []uint32
		for i, j := range jobs {
			if j < 45 || i%3 == 0 {
				sampled = append(sampled, j)
			}
		}
		jobs = sampled
		dirs = []uint{0, 2}
	}

	var cases []sweepCase
	for _, job := range jobs {
		if resolve.IsDoram(job) {
			continue
		}
		for _, g := range []rotype.Gender{rotype.Female, rotype.Male} {
			for _, outfit := range []uint32{0, 1} {
				for _, mado := range []rotype.MadogearType{rotype.MadogearRobot, rotype.MadogearSuit} {
					if mado == rotype.MadogearSuit && !resolve.IsMadogear(job) {
						continue
					}
					for _, d := range dirs {
						cases = append(cases, sweepCase{job: job, gender: g, outfit: outfit, mado: mado, head: 1, dir: d})
					}
				}
			}
		}
	}

	res := runSweep(t, e, cases)
	t.Logf("bodies: %d renders, %d showed skin, %d showed none", res.rendered, res.withSkin, res.noSkin)
	reportFailures(t, res)
	if res.withSkin < 200 {
		t.Errorf("only %d renders showed any skin; the sweep is not covering the library", res.withSkin)
	}
}

// TestSkinSweepAllHeads covers all 42 head sprites per gender. Heads are shared
// across every job, so they are swept once rather than crossed with jobs.
func TestSkinSweepAllHeads(t *testing.T) {
	e := newEngine(t)
	var cases []sweepCase
	for head := uint32(1); head <= 42; head++ {
		for _, g := range []rotype.Gender{rotype.Female, rotype.Male} {
			for _, d := range []uint{0, 1, 2, 5, 7} {
				// Job 1 (swordman) is a plain human body; the head is what varies.
				cases = append(cases, sweepCase{job: 1, gender: g, head: head, dir: d})
			}
		}
	}
	res := runSweep(t, e, cases)
	t.Logf("heads: %d renders, %d head/gender pairs recoloured, %d not", res.rendered, res.withSkin, res.noSkin)
	reportFailures(t, res)
	if res.withSkin != 84 {
		t.Errorf("%d of 84 head/gender pairs recoloured", res.withSkin)
	}
}

// TestSkinSweepClothesDyes is the check that the bake's claim holds: the indices
// it calls skin are the same under every clothes dye, so a tone must recolour
// exactly the same number of pixels whichever dye is applied. A dye-dependent
// count would mean a garment index had been mistaken for skin.
func TestSkinSweepClothesDyes(t *testing.T) {
	e := newEngine(t)
	jobs := []uint32{1, 7, 12, 4066, 4069, 4082, 4201, 4211}
	checked := 0
	for _, job := range jobs {
		for _, g := range []rotype.Gender{rotype.Female, rotype.Male} {
			counts := map[int]int{}
			for dye := 0; dye < 8; dye++ {
				req := Request{
					Job: job, Gender: g, Head: 1, Action: 0, Frame: 0,
					BodyPalette: dye, HeadPalette: -1, HeadDir: rotype.All, EnableShadow: false,
				}
				req.SkinTone = 1
				plain, err := e.Render(req)
				if err != nil || len(plain.Frames) == 0 {
					continue
				}
				req.SkinTone = skin.PresetCount
				toned, err := e.Render(req)
				if err != nil || len(toned.Frames) == 0 {
					continue
				}
				checked++
				counts[dye] = diffPixels(plain.Frames[0], toned.Frames[0])
			}
			var first = -1
			for dye := 0; dye < 8; dye++ {
				n, ok := counts[dye]
				if !ok {
					continue
				}
				if first < 0 {
					first = n
					continue
				}
				if n != first {
					t.Errorf("job %d gender %v: dye %d recoloured %d pixels, dye 0 recoloured %d — the skin indices are not dye-independent",
						job, g, dye, n, first)
				}
			}
		}
	}
	t.Logf("clothes dyes: %d renders checked", checked)
	if checked < 50 {
		t.Errorf("only %d dye renders checked", checked)
	}
}

// TestSkinSweepDoramUntouched is the other half of the contract: doram is out of
// scope, so a tone must be a no-op there rather than a partial recolour.
func TestSkinSweepDoramUntouched(t *testing.T) {
	e := newEngine(t)
	checked := 0
	for _, job := range []uint32{4217, 4218, 4219, 4220, 4221, 4308, 4315} {
		for _, g := range []rotype.Gender{rotype.Female, rotype.Male} {
			for _, d := range []uint{0, 2} {
				req := Request{
					Job: job, Gender: g, Head: 1, Action: d, Frame: 0,
					BodyPalette: -1, HeadPalette: -1, HeadDir: rotype.All, EnableShadow: false,
				}
				req.SkinTone = 1
				a, err := e.Render(req)
				if err != nil || len(a.Frames) == 0 {
					continue
				}
				req.SkinTone = skin.PresetCount
				b, err := e.Render(req)
				if err != nil || len(b.Frames) == 0 {
					continue
				}
				checked++
				if !framesEqual(a.Frames[0], b.Frames[0]) {
					t.Errorf("doram job %d gender %v dir %d changed with a skin tone", job, g, d)
				}
			}
		}
	}
	t.Logf("doram: %d renders checked, all unchanged", checked)
	if checked == 0 {
		t.Skip("no doram sprites extracted")
	}
}

func reportFailures(t *testing.T, res sweepResult) {
	t.Helper()
	if len(res.failures) == 0 {
		return
	}
	sort.Strings(res.failures)
	shown := res.failures
	if len(shown) > 25 {
		shown = shown[:25]
	}
	for _, f := range shown {
		t.Error(f)
	}
	if len(res.failures) > len(shown) {
		t.Errorf("...and %d more failures", len(res.failures)-len(shown))
	}
}
