package encode

import (
	"bytes"
	"image/png"
	"testing"

	"github.com/kettek/apng"

	"github.com/ragassets/gateway/internal/render/raster"
)

func solid(w, h int, c raster.Color) raster.RawImage {
	im := raster.NewRawImage(w, h)
	for i := range im.Pixels {
		im.Pixels[i] = c
	}
	return im
}

func TestPNG_SingleFrame(t *testing.T) {
	im := solid(3, 2, raster.Color{R: 10, G: 20, B: 30, A: 255})
	data, err := PNG(im)
	if err != nil {
		t.Fatalf("PNG: %v", err)
	}
	dec, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if b := dec.Bounds(); b.Dx() != 3 || b.Dy() != 2 {
		t.Errorf("size = %dx%d, want 3x2", b.Dx(), b.Dy())
	}
}

func TestAnimation_SingleFrameIsPNG(t *testing.T) {
	data, err := Animation([]raster.RawImage{solid(2, 2, raster.Color{A: 255})}, 4)
	if err != nil {
		t.Fatalf("Animation: %v", err)
	}
	// A single frame must be a plain (non-animated) PNG: no acTL chunk.
	if bytes.Contains(data, []byte("acTL")) {
		t.Error("single-frame output should not be an APNG")
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		t.Errorf("not a valid PNG: %v", err)
	}
}

func TestAnimation_MultiFrameAPNG(t *testing.T) {
	frames := []raster.RawImage{
		solid(4, 4, raster.Color{R: 255, A: 255}),
		solid(4, 4, raster.Color{G: 255, A: 255}),
		solid(4, 4, raster.Color{B: 255, A: 255}),
	}
	data, err := Animation(frames, 4)
	if err != nil {
		t.Fatalf("Animation: %v", err)
	}
	a, err := apng.DecodeAll(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	if len(a.Frames) != 3 {
		t.Fatalf("frames = %d, want 3", len(a.Frames))
	}
	// Delay numerator = 25 * interval (=100), denominator = 1000.
	if a.Frames[0].DelayNumerator != 100 || a.Frames[0].DelayDenominator != 1000 {
		t.Errorf("delay = %d/%d, want 100/1000", a.Frames[0].DelayNumerator, a.Frames[0].DelayDenominator)
	}
}

func TestAnimation_Empty(t *testing.T) {
	data, err := Animation(nil, 4)
	if err != nil {
		t.Fatalf("Animation(nil): %v", err)
	}
	if data != nil {
		t.Error("expected nil bytes for no frames")
	}
}
