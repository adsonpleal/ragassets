package main

import (
	"fmt"
	"log"
	"math"
	"sort"

	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/resource"
	"github.com/ragassets/gateway/internal/render/roformat"
	"github.com/ragassets/gateway/internal/render/skin"
)

// ---- skin ramp detection ------------------------------------------------

// slotIndex maps a palette index to the skin-ramp slot it represents.
type slotIndex struct {
	Index, Slot int
}

type skinResult struct {
	slots []slotIndex
	// found is false when the sprite has no skin at all (a fully suited body).
	found bool
	// loose counts indices accepted only because their pixels sit next to
	// confirmed skin, rather than because they form a run.
	loose int
	// rejected counts skin-coloured indices that were NOT accepted.
	rejected int
}

// minRun is how many consecutive ramp slots must line up in the palette before a
// block is taken as skin on sight. Eight specific colours in order is already an
// overwhelming signature; three still is, and requiring all eight would drop
// sprites that simply never use the lightest highlight.
const minRun = 3

// detectSkin maps every palette index that represents human skin to its ramp slot.
//
// It does NOT look for "the" ramp. Sprites carry skin at more than one place:
// 타조원더러_여 has a full run at 48-55 *and* another at 240-247, and
// costume_1/레인져늑대_여_1 has 32-39 plus a 43-pixel block at 240-247. Recolouring
// only one leaves the rest of the skin in its original colour. Some sprites also
// carry a stray skin shade outside any run, and 미케닉_남_1 has no eight-long run at
// all because it never uses the lightest highlight.
//
// So: blocks of at least minRun consecutive slots are taken directly, and an
// isolated skin-coloured index is taken only when its pixels actually touch
// confirmed skin somewhere in the sprite. That adjacency test is what stops a
// mount's fur or a garment that happens to reuse one skin colour from being
// swept in — a real risk, since several mounts are cream or tan.
func detectSkin(spr *roformat.Spr, dyePals []roformat.Palette) skinResult {
	pal := spr.Palette()
	var res skinResult

	// Candidate index -> slot, for every index carrying a canonical skin colour.
	cand := map[int]int{}
	for i := 1; i < len(pal); i++ { // index 0 always decodes transparent
		for slot, want := range skin.BaseRamp {
			if nearlyEqual(pal[i], want) {
				cand[i] = slot
				break
			}
		}
	}
	if len(cand) == 0 {
		return res
	}

	accepted := map[int]int{}
	// Pass 1: consecutive palette indices whose slots also ascend consecutively.
	for i := range cand {
		if _, done := accepted[i]; done {
			continue
		}
		n := 0
		for k := 0; ; k++ {
			slot, ok := cand[i+k]
			if !ok || slot != cand[i]+k {
				break
			}
			n++
		}
		if n < minRun {
			continue
		}
		// Only start a block at its true beginning.
		if prev, ok := cand[i-1]; ok && prev == cand[i]-1 {
			continue
		}
		for k := 0; k < n; k++ {
			accepted[i+k] = cand[i+k]
		}
	}

	// Pass 2: adopt isolated candidates whose pixels touch accepted skin.
	if len(accepted) > 0 && len(accepted) < len(cand) {
		for i, slot := range cand {
			if _, ok := accepted[i]; ok {
				continue
			}
			if touchesAccepted(spr, byte(i), accepted) {
				accepted[i] = slot
				res.loose++
			}
		}
	}

	for i, slot := range cand {
		if _, ok := accepted[i]; !ok {
			res.rejected++
			_ = slot
		}
	}
	if len(accepted) == 0 {
		return res
	}
	for i, slot := range accepted {
		res.slots = append(res.slots, slotIndex{Index: i, Slot: slot})
	}
	sort.Slice(res.slots, func(a, b int) bool { return res.slots[a].Index < res.slots[b].Index })
	res.found = true
	return res
}

// touchesAccepted reports whether any pixel of the given palette index is
// 4-adjacent to a pixel of an already-confirmed skin index, anywhere in the sprite.
func touchesAccepted(spr *roformat.Spr, target byte, accepted map[int]int) bool {
	for img := 0; img < spr.ImageCount(0); img++ {
		idx, w, h := spr.DecodeIndices(img)
		if idx == nil {
			continue
		}
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				if idx[y*w+x] != target {
					continue
				}
				for _, d := range [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
					nx, ny := x+d[0], y+d[1]
					if nx < 0 || ny < 0 || nx >= w || ny >= h {
						continue
					}
					if _, ok := accepted[int(idx[ny*w+nx])]; ok {
						return true
					}
				}
			}
		}
	}
	return false
}

// nearlyEqual allows one step of drift per channel. Six head sprites store
// bd736c where the canonical ramp has bd736b — a rounding difference in whatever
// produced them. Demanding exact equality silently drops those heads, and 1/255
// is not a different colour.
func nearlyEqual(a, b raster.Color) bool {
	return absDiff(a.R, b.R) <= 1 && absDiff(a.G, b.G) <= 1 && absDiff(a.B, b.B) <= 1
}

func absDiff(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

type bodyStats struct{ matched, noSkin, multi, loose int }

func bakeBodies(cfg config, mgr *resource.Manager, dyes map[string][]string, out map[string][]int) (bodyStats, error) {
	var st bodyStats
	for _, g := range []string{"여", "남"} {
		names, err := walkSprites(cfg.resources, humanRace+"/"+bodyDir+"/"+g)
		if err != nil {
			return st, fmt.Errorf("walking body sprites: %w", err)
		}
		for _, name := range names {
			spr, err := mgr.Spr(name)
			if err != nil {
				continue
			}
			res := detectSkin(spr, loadDyes(mgr, dyes[name]))
			if !res.found {
				st.noSkin++
				if cfg.verbose {
					log.Printf("  body %s: no skin", name)
				}
				continue
			}
			st.matched++
			if len(res.slots) > 8 {
				st.multi++
				if cfg.verbose {
					log.Printf("  body %s: %d skin indices (more than one ramp position)", name, len(res.slots))
				}
			}
			if res.loose > 0 {
				st.loose++
			}
			out[name] = encodeSlots(res.slots)
		}
	}
	return st, nil
}

func loadDyes(mgr *resource.Manager, names []string) []roformat.Palette {
	out := make([]roformat.Palette, 0, len(names))
	for _, n := range names {
		if p, err := mgr.Pal(n); err == nil {
			out = append(out, p)
		}
	}
	return out
}

// ---- the canonical face mask -------------------------------------------

// The mask lives in "head space": sprite pixels placed at the offset the ACT
// gives them, so every hairstyle's face lands in the same place and they can be
// stacked. Window is generous; heads occupy roughly x -20..16, y -88..-46.
const (
	maskW, maskH   = 128, 128
	maskX0, maskY0 = -64, -128
)

type faceMask struct {
	on    []bool
	heads int
}

// placement returns where an SPR image is drawn in head space: the ACT positions
// each layer by its centre, so the top-left is offset by half the image size.
func placement(act *roformat.Act, spr *roformat.Spr, img int) (x, y int, ok bool) {
	for a := range act.Actions {
		for f := range act.Actions[a].Frames {
			for _, s := range act.Actions[a].Frames[f].Sprites {
				if s.SprType != 0 || s.SprID != img {
					continue
				}
				w, h := spr.ImageSize(img, 0)
				if w <= 0 || h <= 0 {
					return 0, 0, false
				}
				return s.X - w/2, s.Y - h/2, true
			}
		}
	}
	return 0, 0, false
}

type headSprite struct {
	name string
	spr  *roformat.Spr
	act  *roformat.Act
	skin []slotIndex
}

// skinSet is the set of palette indices this sprite draws skin with.
func (h headSprite) skinSet() map[byte]bool {
	m := make(map[byte]bool, len(h.skin))
	for _, s := range h.skin {
		m[byte(s.Index)] = true
	}
	return m
}

// encodeSlots flattens index/slot pairs for the JSON table.
func encodeSlots(slots []slotIndex) []int {
	out := make([]int, 0, len(slots)*2)
	for _, s := range slots {
		out = append(out, s.Index, s.Slot)
	}
	return out
}

// buildMasks stacks every head's skin pixels per SPR image index and keeps the
// pixels enough of them agree on. One head's face could be a coincidence; forty
// agreeing is a face.
func buildMasks(heads []headSprite, threshold float64) map[int]*faceMask {
	counts := map[int][]int{}
	total := map[int]int{}

	for _, h := range heads {
		skinSet := h.skinSet()
		for img := 0; img < h.spr.ImageCount(0); img++ {
			ox, oy, ok := placement(h.act, h.spr, img)
			if !ok {
				continue
			}
			idx, w, hgt := h.spr.DecodeIndices(img)
			if idx == nil {
				continue
			}
			if counts[img] == nil {
				counts[img] = make([]int, maskW*maskH)
			}
			total[img]++
			for y := 0; y < hgt; y++ {
				for x := 0; x < w; x++ {
					if !skinSet[idx[y*w+x]] {
						continue
					}
					gx, gy := ox+x-maskX0, oy+y-maskY0
					if gx < 0 || gy < 0 || gx >= maskW || gy >= maskH {
						continue
					}
					counts[img][gy*maskW+gx]++
				}
			}
		}
	}

	out := map[int]*faceMask{}
	for img, c := range counts {
		m := &faceMask{on: make([]bool, maskW*maskH), heads: total[img]}
		need := float64(total[img]) * threshold
		for i, n := range c {
			if float64(n) >= need && n > 0 {
				m.on[i] = true
			}
		}
		fillHoles(m.on)
		out[img] = m
	}
	return out
}

// fillHoles marks everything the mask encloses. Eyes, brows and the mouth are
// holes in the skin vote but are unmistakably inside the face.
func fillHoles(on []bool) {
	outside := make([]bool, len(on))
	var stack []int
	push := func(i int) {
		if i >= 0 && i < len(on) && !outside[i] && !on[i] {
			outside[i] = true
			stack = append(stack, i)
		}
	}
	for x := 0; x < maskW; x++ {
		push(x)
		push((maskH-1)*maskW + x)
	}
	for y := 0; y < maskH; y++ {
		push(y * maskW)
		push(y*maskW + maskW - 1)
	}
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		x, y := p%maskW, p/maskW
		if x > 0 {
			push(p - 1)
		}
		if x < maskW-1 {
			push(p + 1)
		}
		if y > 0 {
			push(p - maskW)
		}
		if y < maskH-1 {
			push(p + maskW)
		}
	}
	for i := range on {
		if !outside[i] {
			on[i] = true
		}
	}
}

// ---- face-lighting run detection ---------------------------------------

type pixelRun struct {
	srcIndex int
	tMilli   int
	offsets  []int32
	byA, byB bool
}

// findRuns locates the pixels whose palette index is shared with hair but which
// are really part of the face's lighting.
//
// Two independent rules, unioned. Each clause was pinned by a real sprite that
// broke without it:
//
//	A: a run every one of whose opaque neighbours is skin. Provably not hair —
//	   hair would touch hair somewhere.
//	B: a run that lies wholly inside the canonical face, is brighter than the
//	   brightest skin present in that very frame, touches skin somewhere, and is
//	   compact. Per-pixel skin adjacency instead of per-run drops blob interiors
//	   (2_남); allowing runs that leave the mask eats hair strands crossing the
//	   face (25_남); thresholding on a fixed palette slot instead of the skin
//	   actually present misses dimmer highlights (6_남); without brightness it
//	   grabs eyes.
func findRuns(h headSprite, img int, mask *faceMask, maxSide int) []pixelRun {
	idx, w, hgt := h.spr.DecodeIndices(img)
	if idx == nil {
		return nil
	}
	pal := h.spr.Palette()

	skinSet := h.skinSet()
	// Brightest skin actually present in this frame — not a fixed palette slot,
	// which is often unused and sets the bar impossibly high.
	topL := 0.0
	for _, v := range idx {
		if skinSet[v] {
			if l := skin.Lightness(pal[v]); l > topL {
				topL = l
			}
		}
	}

	ox, oy, placed := placement(h.act, h.spr, img)
	inMask := func(x, y int) bool {
		if mask == nil || !placed {
			return false
		}
		gx, gy := ox+x-maskX0, oy+y-maskY0
		if gx < 0 || gy < 0 || gx >= maskW || gy >= maskH {
			return false
		}
		return mask.on[gy*maskW+gx]
	}

	neighbours := [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
	seen := make([]bool, len(idx))
	var out []pixelRun

	for y := 0; y < hgt; y++ {
		for x := 0; x < w; x++ {
			p := y*w + x
			v := idx[p]
			if seen[p] || v == 0 || skinSet[v] {
				continue
			}
			// Flood the 4-connected run of this exact index.
			comp := []int{p}
			seen[p] = true
			stack := []int{p}
			touchSkin, foreign, insideAll := false, 0, true
			x0, y0, x1, y1 := x, y, x, y
			for len(stack) > 0 {
				q := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				qx, qy := q%w, q/w
				if qx < x0 {
					x0 = qx
				}
				if qx > x1 {
					x1 = qx
				}
				if qy < y0 {
					y0 = qy
				}
				if qy > y1 {
					y1 = qy
				}
				if !inMask(qx, qy) {
					insideAll = false
				}
				for _, d := range neighbours {
					nx, ny := qx+d[0], qy+d[1]
					if nx < 0 || ny < 0 || nx >= w || ny >= hgt {
						continue
					}
					np := ny*w + nx
					nv := idx[np]
					if nv == v {
						if !seen[np] {
							seen[np] = true
							comp = append(comp, np)
							stack = append(stack, np)
						}
						continue
					}
					if nv == 0 {
						continue // transparent neighbours say nothing either way
					}
					if skinSet[nv] {
						touchSkin = true
					} else {
						foreign++
					}
				}
			}

			byA := touchSkin && foreign == 0
			byB := insideAll && touchSkin &&
				skin.Lightness(pal[v]) > topL+0.01 &&
				maxInt(x1-x0+1, y1-y0+1) <= maxSide
			if !byA && !byB {
				continue
			}

			offsets := make([]int32, 0, len(comp))
			for _, q := range comp {
				offsets = append(offsets, int32(q))
			}
			sort.Slice(offsets, func(i, j int) bool { return offsets[i] < offsets[j] })
			out = append(out, pixelRun{
				srcIndex: int(v),
				tMilli:   rampPosition(pal[v]),
				offsets:  offsets,
				byA:      byA,
				byB:      byB,
			})
		}
	}
	return out
}

// rampPosition places a colour on the sprite's own skin ramp by lightness: 0 at
// the lightest skin tone, 1000 at the darkest, negative above. Baking this rather
// than the source colour is what keeps a hair dye from leaking into the face —
// the pixel follows the requested skin tone, not whatever index 216 happens to be.
func rampPosition(c raster.Color) int {
	top := skin.Lightness(skin.BaseRamp[0])
	bot := skin.Lightness(skin.BaseRamp[len(skin.BaseRamp)-1])
	return int(math.Round((top - skin.Lightness(c)) / (top - bot) * 1000))
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ---- head baking --------------------------------------------------------

type headStats struct {
	matched, nonCanonical int
	dyedHeads             int
	runs, pixels          int
	headsWithRuns         int
	onlyA, onlyB, both    int
}

func bakeHeads(cfg config, mgr *resource.Manager, dyes map[string][]string, out map[string]headOut) (headStats, error) {
	var st headStats
	for _, g := range []string{"여", "남"} {
		names, err := walkSprites(cfg.resources, humanRace+"/"+headDir+"/"+g)
		if err != nil {
			return st, fmt.Errorf("walking head sprites: %w", err)
		}

		var heads []headSprite
		for _, name := range names {
			spr, act, err := loadPair(mgr, name)
			if err != nil {
				continue
			}
			res := detectSkin(spr, loadDyes(mgr, dyes[name]))
			if !res.found {
				log.Printf("  head %s: no skin (skipped)", name)
				continue
			}
			if len(res.slots) != 8 || res.slots[0].Index != 128 {
				st.nonCanonical++
				log.Printf("  head %s: %d skin indices starting at %d, not the usual 128-135",
					name, len(res.slots), res.slots[0].Index)
			}
			heads = append(heads, headSprite{name: name, spr: spr, act: act, skin: res.slots})
		}

		masks := buildMasks(heads, cfg.maskThreshold)
		if cfg.sheets != "" {
			if err := writeSheets(cfg.sheets, g, heads, masks, cfg.maxRunSide); err != nil {
				return st, fmt.Errorf("writing review sheets: %w", err)
			}
		}

		for _, h := range heads {
			st.matched++
			entry := headOut{Skin: encodeSlots(h.skin), Px: map[string][][]int{}}
			hadRuns := false
			for img := 0; img < h.spr.ImageCount(0); img++ {
				runs := findRuns(h, img, masks[img], cfg.maxRunSide)
				if len(runs) == 0 {
					continue
				}
				hadRuns = true
				merged := mergeRuns(runs)
				enc := make([][]int, 0, len(merged))
				for _, r := range merged {
					row := make([]int, 0, len(r.offsets)+2)
					row = append(row, r.srcIndex, r.tMilli)
					for _, o := range r.offsets {
						row = append(row, int(o))
					}
					enc = append(enc, row)
					st.runs++
					st.pixels += len(r.offsets)
					switch {
					case r.byA && r.byB:
						st.both += len(r.offsets)
					case r.byA:
						st.onlyA += len(r.offsets)
					default:
						st.onlyB += len(r.offsets)
					}
				}
				entry.Px[fmt.Sprint(img)] = enc
			}
			if hadRuns {
				st.headsWithRuns++
			}
			// The key is kept even with no runs: "known, nothing to do" must stay
			// distinguishable from "sprite not in the table".
			out[h.name] = entry
		}
	}
	return st, nil
}

// mergeRuns folds runs that share a source index and ramp position into one, so
// the encoded table carries one colour per group rather than per blob.
func mergeRuns(runs []pixelRun) []pixelRun {
	type key struct{ src, t int }
	order := []key{}
	byKey := map[key]*pixelRun{}
	for _, r := range runs {
		k := key{r.srcIndex, r.tMilli}
		cur, ok := byKey[k]
		if !ok {
			cp := r
			byKey[k] = &cp
			order = append(order, k)
			continue
		}
		cur.offsets = append(cur.offsets, r.offsets...)
		cur.byA = cur.byA || r.byA
		cur.byB = cur.byB || r.byB
	}
	out := make([]pixelRun, 0, len(order))
	for _, k := range order {
		r := byKey[k]
		sort.Slice(r.offsets, func(i, j int) bool { return r.offsets[i] < r.offsets[j] })
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].srcIndex != out[j].srcIndex {
			return out[i].srcIndex < out[j].srcIndex
		}
		return out[i].tMilli < out[j].tMilli
	})
	return out
}
