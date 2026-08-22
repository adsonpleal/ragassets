package skin

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// skinTableJSON maps every player body/head sprite to the palette indices its
// skin ramp occupies, plus — for heads — the individual pixels that must be
// repainted because their palette index is shared with hair.
//
// Regenerate with: go run ./cmd/gen-skin-table -resources ../resources
//
//go:embed data/skin_table.json
var skinTableJSON []byte

// TableVersion is the schema version the loader understands.
const TableVersion = 1

// Run is a set of pixels that all take one colour from the tone ramp.
type Run struct {
	// SrcIndex is the palette index these pixels use in the sprite. Diagnostic:
	// it is what makes a bad bake auditable, and is asserted by the tests.
	SrcIndex int
	// Pos is the run's position on the skin ramp — 0 is the lightest skin tone,
	// 1 the darkest, and negative means brighter than any skin tone (a specular
	// highlight). Baked from the sprite's own palette so the colour follows the
	// requested tone and never the hair dye.
	Pos float64
	// Offsets index RawImage.Pixels (x + y*width). Read-only.
	Offsets []int32
}

// SlotIndex maps a palette index to the skin-ramp slot it represents.
type SlotIndex struct {
	Index, Slot int
}

// HeadEntry is the baked data for one head sprite.
type HeadEntry struct {
	Skin []SlotIndex
	// Px holds the pixel runs per SPR image index. Empty (but present) for the
	// heads that need no repainting.
	Px map[int][]Run
}

type rawTable struct {
	Version int                `json:"version"`
	Base    []string           `json:"base"`
	Body    map[string][]int   `json:"body"`
	Head    map[string]rawHead `json:"head"`
}

type rawHead struct {
	Skin []int              `json:"skin"`
	Px   map[string][][]int `json:"px"`
}

var (
	bodyTable map[string][]SlotIndex
	headTable map[string]HeadEntry
)

func init() {
	var raw rawTable
	if err := json.Unmarshal(skinTableJSON, &raw); err != nil {
		panic("skin: bad embedded skin_table.json: " + err.Error())
	}
	if raw.Version != TableVersion {
		panic(fmt.Sprintf("skin: skin_table.json version %d, want %d", raw.Version, TableVersion))
	}

	bodyTable = make(map[string][]SlotIndex, len(raw.Body))
	for path, flat := range raw.Body {
		sl, err := toSlots(flat)
		if err != nil {
			panic(fmt.Sprintf("skin: body %q: %v", path, err))
		}
		bodyTable[path] = sl
	}

	headTable = make(map[string]HeadEntry, len(raw.Head))
	for path, h := range raw.Head {
		sl, err := toSlots(h.Skin)
		if err != nil {
			panic(fmt.Sprintf("skin: head %q: %v", path, err))
		}
		e := HeadEntry{Skin: sl, Px: make(map[int][]Run, len(h.Px))}
		for imgStr, runs := range h.Px {
			var img int
			if _, err := fmt.Sscanf(imgStr, "%d", &img); err != nil {
				panic(fmt.Sprintf("skin: head %q: bad image key %q", path, imgStr))
			}
			for _, run := range runs {
				if len(run) < 3 {
					panic(fmt.Sprintf("skin: head %q image %d: run needs srcIndex, pos and at least one offset", path, img))
				}
				offsets := make([]int32, 0, len(run)-2)
				for _, o := range run[2:] {
					offsets = append(offsets, int32(o))
				}
				e.Px[img] = append(e.Px[img], Run{
					SrcIndex: run[0],
					Pos:      float64(run[1]) / 1000,
					Offsets:  offsets,
				})
			}
		}
		headTable[path] = e
	}
}

// toSlots decodes the flat index,slot pair encoding.
func toSlots(flat []int) ([]SlotIndex, error) {
	if len(flat) == 0 || len(flat)%2 != 0 {
		return nil, fmt.Errorf("expected index,slot pairs, got %d values", len(flat))
	}
	out := make([]SlotIndex, 0, len(flat)/2)
	for i := 0; i < len(flat); i += 2 {
		idx, slot := flat[i], flat[i+1]
		if idx < 1 || idx > 255 {
			// Index 0 always decodes transparent, so it can never carry skin.
			return nil, fmt.Errorf("palette index out of range: %d", idx)
		}
		if slot < 0 || slot >= len(BaseRamp) {
			return nil, fmt.Errorf("ramp slot out of range: %d", slot)
		}
		out = append(out, SlotIndex{Index: idx, Slot: slot})
	}
	return out, nil
}

// Body returns the palette indices that carry skin for a body sprite, each with
// the ramp slot it represents. A sprite can hold skin at more than one position,
// so this is a list rather than a single range.
//
// ok is false for sprites with no skin at all (madogear and other suited bodies),
// which is a normal outcome, not an error.
func Body(spritePath string) ([]SlotIndex, bool) {
	r, ok := bodyTable[spritePath]
	return r, ok
}

// Head returns the baked entry for a head sprite.
func Head(spritePath string) (HeadEntry, bool) {
	e, ok := headTable[spritePath]
	return e, ok
}

// Counts reports how many body and head sprites the table covers.
func Counts() (bodies, heads int) { return len(bodyTable), len(headTable) }
