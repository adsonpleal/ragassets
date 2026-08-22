package skin

import (
	"math"

	"github.com/ragassets/gateway/internal/render/raster"
)

// BaseRamp is the canonical human skin ramp: the eight colours RO stores at head
// palette indices 128-135, lightest to darkest. Body sprites carry the same eight
// colours, but at a position that varies per sprite — see the baked table.
var BaseRamp = [8]raster.Color{
	{R: 0xf7, G: 0xf0, B: 0xe5, A: 0xff},
	{R: 0xff, G: 0xe1, B: 0xcf, A: 0xff},
	{R: 0xff, G: 0xc6, B: 0xb2, A: 0xff},
	{R: 0xf6, G: 0xae, B: 0x9f, A: 0xff},
	{R: 0xdc, G: 0x90, B: 0x84, A: 0xff},
	{R: 0xbd, G: 0x73, B: 0x6b, A: 0xff},
	{R: 0x9e, G: 0x56, B: 0x52, A: 0xff},
	{R: 0x82, G: 0x3f, B: 0x3b, A: 0xff},
}

// MidIndex is the ramp step a custom colour is anchored to: the dominant lit
// midtone, the shade that covers most of a face and limbs. Anchoring a custom
// colour to the highlight instead would render dark inputs far darker than asked.
const MidIndex = 3

// The base ramp decomposed once, at init. Derived from BaseRamp rather than
// hardcoded so the hex above stays the single source of truth.
var (
	baseT          [8]float64 // ramp position, 0 = lightest .. 1 = darkest
	baseCW         [8]float64 // chroma as a fraction of the ramp's peak chroma
	baseH          [8]float64 // hue in degrees
	baseP          [8]float64 // 1 - baseT, the lightness interpolation factor
	baseLo, baseHi float64
	basePeakC      float64

	tNodes  []float64
	cwNodes []float64
	hNodes  []float64
)

func init() {
	var l [8]float64
	for i, c := range BaseRamp {
		p := colorToLCH(c)
		l[i] = p.L
		baseH[i] = p.H
		if p.C > basePeakC {
			basePeakC = p.C
		}
	}
	baseHi, baseLo = l[0], l[7]
	span := baseHi - baseLo
	for i, c := range BaseRamp {
		baseP[i] = (l[i] - baseLo) / span
		baseT[i] = 1 - baseP[i]
		baseCW[i] = colorToLCH(c).C / basePeakC
	}
	tNodes = baseT[:]
	cwNodes = baseCW[:]
	hNodes = baseH[:]

	// The identity tone's parameters are the base ramp's own, so ColorAt stays
	// meaningful for it (the face-highlight override evaluates it at negative p).
	// Without this it would inherit zero values and evaluate to black.
	presets[1] = Tone{
		Ltop:      baseHi,
		Lbot:      baseLo,
		HueAnchor: baseH[len(baseH)-1],
		ChromaMax: basePeakC,
		identity:  true,
	}
}

// Tone is a parameterised recolouring of the base ramp. It is never a list of
// baked colours: expressing it as parameters is what lets the palette recolour
// and the per-pixel face-highlight override share one evaluator, so the two can
// never drift apart.
type Tone struct {
	// Ltop/Lbot are the Oklab lightness span the base ramp is remapped into.
	Ltop, Lbot float64
	// HueShift rotates the base ramp's hue curve (0 for the presets; set by
	// FromColor so a custom colour reproduces exactly at MidIndex).
	HueShift float64
	// HueAnchor is the warm hue shadows drift toward, HueBlend how far.
	HueAnchor, HueBlend float64
	// ChromaMax scales the ramp's chroma; ChromaFloor (0..1) keeps highlights
	// from going grey; Taper desaturates the shadow end, as real skin does.
	ChromaMax, ChromaFloor, Taper float64

	identity bool
}

// Identity reports whether this tone leaves the sprite untouched.
func (t Tone) Identity() bool { return t.identity }

// ColorAt evaluates the ramp at position p, where 0 is the lightest ramp step and
// 1 the darkest. Values outside [0,1] extrapolate: face speculars sit at a
// negative p because they are brighter than the lightest skin tone.
func (t Tone) ColorAt(p float64) raster.Color {
	factor := 1 - p // the base ramp's own lightness interpolation factor
	l := t.Lbot + factor*(t.Ltop-t.Lbot)

	// Chroma follows the base ramp's shape, floored so highlights keep some
	// warmth, then tapered into the shadows. Extrapolated highlights (factor > 1)
	// get no taper.
	cw := interp(tNodes, cwNodes, p)
	taper := 1 - t.Taper*(1-math.Min(factor, 1))
	c := t.ChromaMax * (t.ChromaFloor + (1-t.ChromaFloor)*cw) * taper

	h := interp(tNodes, hNodes, p) + t.HueShift
	h = (1-t.HueBlend)*h + t.HueBlend*t.HueAnchor

	return lchToColor(lch{L: l, C: c, H: h})
}

// Ramp evaluates the eight ramp steps that replace a sprite's skin indices.
func (t Tone) Ramp() [8]raster.Color {
	if t.identity {
		return BaseRamp
	}
	var out [8]raster.Color
	for i := range out {
		out[i] = t.ColorAt(baseT[i])
	}
	return out
}

// presets are the four validated tones. skin_color_1 is the untouched original.
// The remaining three were tuned visually across the whole head library; the
// numbers are the outcome of that review, not a formula.
var presets = map[int]Tone{
	1: {identity: true},
	2: {Ltop: 0.858, Lbot: 0.390, HueAnchor: 52, HueBlend: 0.35, ChromaMax: 0.100, ChromaFloor: 0.32, Taper: 0.22},
	3: {Ltop: 0.748, Lbot: 0.318, HueAnchor: 57, HueBlend: 0.55, ChromaMax: 0.092, ChromaFloor: 0.48, Taper: 0.38},
	4: {Ltop: 0.632, Lbot: 0.248, HueAnchor: 60, HueBlend: 0.72, ChromaMax: 0.078, ChromaFloor: 0.60, Taper: 0.50},
}

// PresetCount is the number of selectable presets (1..PresetCount).
const PresetCount = 4

// Preset returns the tone for skin_color_<n>, or ok=false when n is out of range.
func Preset(n int) (Tone, bool) {
	t, ok := presets[n]
	return t, ok
}

// Custom tone shaping. These sit between the presets' own values; the lightness
// span is what FromColor derives per input, the rest are fixed so a custom colour
// still reads as skin rather than as a flat fill.
const (
	customHueBlend    = 0.35
	customChromaFloor = 0.45
	customTaper       = 0.35

	// Bounds on the generated lightness span. minRampL is above zero so the
	// darkest step of a very dark request still carries shading instead of
	// collapsing to flat black and erasing the sprite's form.
	minRampL = 0.10
	maxRampL = 0.97
)

// FromColor builds a full ramp from one colour, treating it as the ramp's
// midtone (MidIndex). The result reproduces the input exactly at that step and
// derives the other seven from the base ramp's own lightness spacing, so the
// sprite keeps its original shading structure instead of being flat-filled.
//
// A fully desaturated input yields a greyscale ramp — hue is undefined there, and
// silently warming it would be a lie about what was asked for.
func FromColor(c raster.Color) Tone {
	in := colorToLCH(c)

	// Contrast compresses slightly for dark inputs so the shadow end does not crush.
	span := (baseHi - baseLo) * (0.75 + 0.25*in.L)
	pMid := baseP[MidIndex]
	top := in.L + (1-pMid)*span
	bot := top - span

	// Very light or very dark inputs push an end of the span out of range. Squeeze
	// the span rather than sliding it: reproducing the requested colour at MidIndex
	// is the contract, so that end stays pinned and only the range compresses.
	if bot < minRampL {
		bot = minRampL
		top = bot + (in.L-bot)/pMid
	}
	if top > maxRampL {
		top = maxRampL
		bot = (in.L - pMid*top) / (1 - pMid)
	}

	t := Tone{
		Ltop:        top,
		Lbot:        bot,
		HueAnchor:   baseH[len(baseH)-1],
		HueBlend:    customHueBlend,
		ChromaFloor: customChromaFloor,
		Taper:       customTaper,
	}

	// Solve HueShift and ChromaMax so ColorAt(baseT[MidIndex]) == the input.
	tMid := baseT[MidIndex]
	t.HueShift = (in.H-t.HueBlend*t.HueAnchor)/(1-t.HueBlend) - interp(tNodes, hNodes, tMid)

	taper := 1 - t.Taper*(1-math.Min(pMid, 1))
	shape := (t.ChromaFloor + (1-t.ChromaFloor)*interp(tNodes, cwNodes, tMid)) * taper
	if shape > 0 {
		t.ChromaMax = in.C / shape
	}
	return t
}
