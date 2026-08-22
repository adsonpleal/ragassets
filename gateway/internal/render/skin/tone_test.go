package skin

import (
	"fmt"
	"math"
	"testing"

	"github.com/ragassets/gateway/internal/render/raster"
)

func hexOf(c raster.Color) string { return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B) }

func rampHex(r [8]raster.Color) string {
	s := ""
	for i, c := range r {
		if i > 0 {
			s += " "
		}
		s += hexOf(c)
	}
	return s
}

// TestPresetRamps pins the four presets to the exact ramps that were reviewed
// visually across the whole head library. These bytes are the outcome of that
// review; if a change to the colour model moves them, the review is stale.
func TestPresetRamps(t *testing.T) {
	want := map[int]string{
		1: "#f7f0e5 #ffe1cf #ffc6b2 #f6ae9f #dc9084 #bd736b #9e5652 #823f3b",
		2: "#e4ccb2 #e9bea4 #e3a78e #d7937d #bd7a66 #9f6151 #82483b #683428",
		3: "#c4a88a #c69c80 #bd8a6e #b07960 #97644d #7c4e3b #613929 #4a281a",
		4: "#a08469 #9f7b61 #956d52 #885f47 #724d38 #5b3b29 #432a1b #301b10",
	}
	for n, w := range want {
		tone, ok := Preset(n)
		if !ok {
			t.Fatalf("Preset(%d) missing", n)
		}
		if got := rampHex(tone.Ramp()); got != w {
			t.Errorf("skin_color_%d ramp =\n  %s\nwant\n  %s", n, got, w)
		}
	}
	if _, ok := Preset(0); ok {
		t.Error("Preset(0) should not exist")
	}
	if _, ok := Preset(PresetCount + 1); ok {
		t.Errorf("Preset(%d) should not exist", PresetCount+1)
	}
}

func TestIdentityIsExactlyTheBaseRamp(t *testing.T) {
	tone, _ := Preset(1)
	if !tone.Identity() {
		t.Fatal("Preset(1) must report Identity")
	}
	if tone.Ramp() != BaseRamp {
		t.Errorf("identity ramp = %s, want the base ramp", rampHex(tone.Ramp()))
	}
	// ColorAt must stay meaningful for the identity tone: the face-highlight
	// override evaluates it at a negative position.
	if c := tone.ColorAt(-0.067); c.R < 0xf0 || c.G < 0xf0 {
		t.Errorf("identity specular = %s, want near-white", hexOf(c))
	}
	for n := 2; n <= PresetCount; n++ {
		if p, _ := Preset(n); p.Identity() {
			t.Errorf("Preset(%d) must not report Identity", n)
		}
	}
}

// TestFromColorReproducesMidtone is the contract for the custom-colour param:
// what you pass is what you get on the ramp step that covers most of the skin.
func TestFromColorReproducesMidtone(t *testing.T) {
	for _, in := range []raster.Color{
		{R: 0xf6, G: 0xae, B: 0x9f, A: 255}, // the base midtone itself
		{R: 0x8a, G: 0x5a, B: 0x3b, A: 255}, // mid brown
		{R: 0x3a, G: 0x24, B: 0x18, A: 255}, // very dark
		{R: 0x2a, G: 0x18, B: 0x10, A: 255}, // darker still (span floor hit)
		{R: 0xff, G: 0xee, B: 0xe4, A: 255}, // near white (span ceiling hit)
		{R: 0x80, G: 0x80, B: 0x80, A: 255}, // fully desaturated
		{R: 0x6b, G: 0x8f, B: 0x3a, A: 255}, // not a skin colour at all
	} {
		got := FromColor(in).ColorAt(baseT[MidIndex])
		for _, d := range []struct {
			name     string
			got, exp uint8
		}{{"R", got.R, in.R}, {"G", got.G, in.G}, {"B", got.B, in.B}} {
			if diff := int(d.got) - int(d.exp); diff > 1 || diff < -1 {
				t.Errorf("FromColor(%s) midtone = %s, %s off by %d", hexOf(in), hexOf(got), d.name, diff)
			}
		}
	}
}

func TestRampsAreWellFormed(t *testing.T) {
	tones := map[string]Tone{}
	for n := 1; n <= PresetCount; n++ {
		tone, _ := Preset(n)
		tones[fmt.Sprintf("preset%d", n)] = tone
	}
	for _, in := range []raster.Color{
		{R: 0xc9, G: 0x9a, B: 0x7f, A: 255},
		{R: 0x5a, G: 0x39, B: 0x28, A: 255},
		{R: 0x2f, G: 0x1c, B: 0x12, A: 255},
		{R: 0xe8, G: 0xc4, B: 0xa6, A: 255},
	} {
		tones["custom"+hexOf(in)] = FromColor(in)
	}

	for name, tone := range tones {
		ramp := tone.Ramp()
		prev := math.Inf(1)
		for i, c := range ramp {
			l := colorToLCH(c).L
			if l > prev+1e-9 {
				t.Errorf("%s: ramp not darkening at step %d (%s)", name, i, rampHex(ramp))
			}
			prev = l
			if c.A != 0xFF {
				t.Errorf("%s: step %d alpha = %d, want 255", name, i, c.A)
			}
		}
		if ramp[0] == ramp[7] {
			t.Errorf("%s: ramp has no range (%s)", name, rampHex(ramp))
		}
		// A specular sits above the ramp; a deep shadow below it.
		if colorToLCH(tone.ColorAt(-0.2)).L <= colorToLCH(ramp[0]).L {
			t.Errorf("%s: ColorAt(-0.2) is not brighter than the lightest step", name)
		}
		if colorToLCH(tone.ColorAt(1.2)).L >= colorToLCH(ramp[7]).L {
			t.Errorf("%s: ColorAt(1.2) is not darker than the darkest step", name)
		}
	}
}

func TestOklabRoundTrip(t *testing.T) {
	for r := 0; r < 256; r += 17 {
		for g := 0; g < 256; g += 17 {
			for b := 0; b < 256; b += 17 {
				in := raster.Color{R: uint8(r), G: uint8(g), B: uint8(b), A: 255}
				out := lchToColor(colorToLCH(in))
				for _, d := range [][2]uint8{{out.R, in.R}, {out.G, in.G}, {out.B, in.B}} {
					if diff := int(d[0]) - int(d[1]); diff > 1 || diff < -1 {
						t.Fatalf("round trip %s -> %s", hexOf(in), hexOf(out))
					}
				}
			}
		}
	}
}
