package skin

//go:generate go run ../../../cmd/gen-tables

// The skin table maps every player body/head sprite to the palette indices its
// skin ramp occupies, plus — for heads — the individual pixels that must be
// repainted because their palette index is shared with hair.
//
// data/skin_table.json is the reviewable source (regenerate it with
// `go run ./cmd/gen-skin-table -resources ../resources`); table_baked_gen.go is
// that file baked into Go by cmd/gen-tables. Nothing parses JSON at runtime, so
// the render path pulls in neither encoding/json nor reflection, and a malformed
// table is a compile error instead of an init-time panic.

// TableVersion is the schema version the loader understands.
const TableVersion = 1

// The generated file records the version of the JSON it came from. If someone
// bumps the schema and regenerates without updating TableVersion (or vice
// versa), this fails to compile rather than silently loading a table with
// different semantics — the guard the old init-time version check provided.
const _ = uint(bakedVersion - TableVersion)
const _ = uint(TableVersion - bakedVersion)

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
