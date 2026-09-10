package encode

import (
	"bytes"
	"image"
	"image/color"
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

// sprite is a frame with a small visible blob on an otherwise transparent
// canvas — the shape real requests have, and the one dirty-rect framing exists
// for.
func sprite(w, h int, blob image.Rectangle, c raster.Color) raster.RawImage {
	im := raster.NewRawImage(w, h)
	for y := blob.Min.Y; y < blob.Max.Y; y++ {
		for x := blob.Min.X; x < blob.Max.X; x++ {
			im.Pixels[x+y*w] = c
		}
	}
	return im
}

// composite replays the decoded APNG the way a viewer does — BLEND_OP_SOURCE
// into the frame's region, DISPOSE_OP_BACKGROUND clearing it afterwards — and
// returns what would be on screen during each frame. This is the check that
// matters: cropping is only allowed to change the bytes, never the picture.
func composite(t *testing.T, a apng.APNG, w, h int) []*image.NRGBA {
	t.Helper()
	out := make([]*image.NRGBA, len(a.Frames))
	canvas := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i, f := range a.Frames {
		b := f.Image.Bounds()
		for y := 0; y < b.Dy(); y++ {
			for x := 0; x < b.Dx(); x++ {
				c := color.NRGBAModel.Convert(f.Image.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA)
				canvas.SetNRGBA(f.XOffset+x, f.YOffset+y, c)
			}
		}
		shot := image.NewNRGBA(canvas.Rect)
		copy(shot.Pix, canvas.Pix)
		out[i] = shot

		if f.DisposeOp == apng.DISPOSE_OP_BACKGROUND {
			for y := 0; y < b.Dy(); y++ {
				for x := 0; x < b.Dx(); x++ {
					canvas.SetNRGBA(f.XOffset+x, f.YOffset+y, color.NRGBA{})
				}
			}
		}
	}
	return out
}

// TestAnimation_DirtyRectCompositesIdentically is the correctness gate on the
// cropped encoding. Each decoded frame, composited, must equal the frame that
// went in — pixel for pixel, padding included.
func TestAnimation_DirtyRectCompositesIdentically(t *testing.T) {
	const w, h = 40, 30
	frames := []raster.RawImage{
		sprite(w, h, image.Rect(5, 5, 12, 20), raster.Color{R: 255, A: 255}),
		sprite(w, h, image.Rect(20, 2, 25, 9), raster.Color{G: 255, A: 255}),
		sprite(w, h, image.Rect(0, 0, 40, 30), raster.Color{B: 255, A: 255}), // fills the canvas
		sprite(w, h, image.Rect(33, 25, 40, 30), raster.Color{R: 9, G: 9, A: 128}),
		raster.NewRawImage(w, h), // nothing visible at all
	}
	data, err := Animation(frames, 4)
	if err != nil {
		t.Fatalf("Animation: %v", err)
	}
	a, err := apng.DecodeAll(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	if len(a.Frames) != len(frames) {
		t.Fatalf("frames = %d, want %d", len(a.Frames), len(frames))
	}

	got := composite(t, a, w, h)
	for i, want := range frames {
		if !bytes.Equal(got[i].Pix, want.ToNRGBA().Pix) {
			t.Errorf("frame %d composites differently than it was rendered", i)
		}
	}
}

// TestAnimation_DirtyRectShrinksFrames pins the point of the change: a sprite on
// a big canvas must not be written as a big canvas.
func TestAnimation_DirtyRectShrinksFrames(t *testing.T) {
	const w, h = 200, 200
	blob := image.Rect(90, 90, 110, 130)
	frames := []raster.RawImage{
		sprite(w, h, blob, raster.Color{R: 255, A: 255}),
		sprite(w, h, blob, raster.Color{G: 255, A: 255}),
		sprite(w, h, blob, raster.Color{B: 255, A: 255}),
	}
	data, err := Animation(frames, 4)
	if err != nil {
		t.Fatalf("Animation: %v", err)
	}
	a, err := apng.DecodeAll(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}

	// The first frame carries the canvas — that is where IHDR's size comes from,
	// and a viewer that only reads the default image must still get 200x200.
	if b := a.Frames[0].Image.Bounds(); b.Dx() != w || b.Dy() != h {
		t.Errorf("first frame = %dx%d, want the full %dx%d canvas", b.Dx(), b.Dy(), w, h)
	}
	for i, f := range a.Frames[1:] {
		b := f.Image.Bounds()
		if b.Dx() != blob.Dx() || b.Dy() != blob.Dy() {
			t.Errorf("frame %d = %dx%d, want the %dx%d blob", i+1, b.Dx(), b.Dy(), blob.Dx(), blob.Dy())
		}
		if f.XOffset != blob.Min.X || f.YOffset != blob.Min.Y {
			t.Errorf("frame %d at (%d,%d), want (%d,%d)", i+1, f.XOffset, f.YOffset, blob.Min.X, blob.Min.Y)
		}
	}
}

// TestAnimation_BlankFrameStaysLegal covers the one frame with no bounding box
// to find. APNG has no zero-sized frame, so it has to become the smallest legal
// one rather than an encoder error.
func TestAnimation_BlankFrameStaysLegal(t *testing.T) {
	frames := []raster.RawImage{
		solid(8, 8, raster.Color{R: 255, A: 255}),
		raster.NewRawImage(8, 8),
	}
	data, err := Animation(frames, 4)
	if err != nil {
		t.Fatalf("Animation: %v", err)
	}
	a, err := apng.DecodeAll(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	if b := a.Frames[1].Image.Bounds(); b.Dx() != 1 || b.Dy() != 1 {
		t.Errorf("blank frame = %dx%d, want 1x1", b.Dx(), b.Dy())
	}
	if _, _, _, alpha := a.Frames[1].Image.At(a.Frames[1].Image.Bounds().Min.X, a.Frames[1].Image.Bounds().Min.Y).RGBA(); alpha != 0 {
		t.Errorf("blank frame pixel alpha = %d, want 0", alpha)
	}
}

// TestAnimation_OddSizedFrameIsNotCropped guards the fallback: a frame that does
// not match the canvas is written whole, since its placement inside the declared
// canvas is not something the encoder can infer.
func TestAnimation_OddSizedFrameIsNotCropped(t *testing.T) {
	frames := []raster.RawImage{
		solid(10, 10, raster.Color{R: 255, A: 255}),
		sprite(6, 6, image.Rect(2, 2, 4, 4), raster.Color{G: 255, A: 255}),
	}
	data, err := Animation(frames, 4)
	if err != nil {
		t.Fatalf("Animation: %v", err)
	}
	a, err := apng.DecodeAll(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	if b := a.Frames[1].Image.Bounds(); b.Dx() != 6 || b.Dy() != 6 {
		t.Errorf("odd frame = %dx%d, want the full 6x6", b.Dx(), b.Dy())
	}
}
