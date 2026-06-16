package raster

import "testing"

func TestAlphaBlend_FastPaths(t *testing.T) {
	src := Color{R: 10, G: 20, B: 30, A: 200}
	// Transparent dest -> src verbatim.
	if got := AlphaBlend(Color{}, src); got != src {
		t.Errorf("over transparent = %+v, want %+v", got, src)
	}
	// Opaque src -> src verbatim regardless of dest.
	opaque := Color{R: 1, G: 2, B: 3, A: 255}
	if got := AlphaBlend(Color{R: 9, G: 9, B: 9, A: 9}, opaque); got != opaque {
		t.Errorf("opaque src = %+v, want %+v", got, opaque)
	}
}

func TestAlphaBlend_Partial(t *testing.T) {
	dest := Color{R: 100, G: 100, B: 100, A: 128}
	src := Color{R: 200, G: 50, B: 0, A: 128}
	// Hand-computed with the exact integer formula.
	want := Color{R: 165, G: 65, B: 32, A: 191}
	if got := AlphaBlend(dest, src); got != want {
		t.Errorf("blend = %+v, want %+v", got, want)
	}
}

func TestTintPixel(t *testing.T) {
	px := Color{R: 200, G: 100, B: 50, A: 255}
	// White opaque tint leaves the pixel unchanged.
	if got := TintPixel(px, Color{R: 255, G: 255, B: 255, A: 255}); got != px {
		t.Errorf("white tint = %+v, want %+v", got, px)
	}
	// Half tint halves each channel (integer floor).
	half := Color{R: 128, G: 128, B: 128, A: 128}
	want := Color{R: 100, G: 50, B: 25, A: 128} // 200*128/255=100, etc.
	if got := TintPixel(px, half); got != want {
		t.Errorf("half tint = %+v, want %+v", got, want)
	}
}
