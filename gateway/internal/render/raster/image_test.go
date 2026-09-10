package raster

import (
	"image"
	"testing"
)

func withPixels(w, h int, set map[[2]int]Color) RawImage {
	im := NewRawImage(w, h)
	for p, c := range set {
		im.Pixels[p[0]+p[1]*w] = c
	}
	return im
}

func TestOpaqueBounds(t *testing.T) {
	opaque := Color{R: 1, A: 255}
	faint := Color{R: 1, A: 1} // still visible, so still inside the box

	cases := []struct {
		name string
		im   RawImage
		want image.Rectangle
	}{
		{"empty image", RawImage{}, image.Rectangle{}},
		{"all transparent", NewRawImage(4, 4), image.Rectangle{}},
		{"one pixel", withPixels(5, 5, map[[2]int]Color{{2, 3}: opaque}), image.Rect(2, 3, 3, 4)},
		{"alpha 1 counts", withPixels(5, 5, map[[2]int]Color{{4, 0}: faint}), image.Rect(4, 0, 5, 1)},
		{"spans corners", withPixels(6, 6, map[[2]int]Color{{1, 4}: opaque, {5, 0}: opaque}), image.Rect(1, 0, 6, 5)},
		{"full canvas", solidRaw(3, 2, opaque), image.Rect(0, 0, 3, 2)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.im.OpaqueBounds(); got != c.want {
				t.Errorf("OpaqueBounds() = %v, want %v", got, c.want)
			}
		})
	}
}

func solidRaw(w, h int, c Color) RawImage {
	im := NewRawImage(w, h)
	for i := range im.Pixels {
		im.Pixels[i] = c
	}
	return im
}

func TestToNRGBARect(t *testing.T) {
	im := NewRawImage(4, 3)
	for y := 0; y < 3; y++ {
		for x := 0; x < 4; x++ {
			im.Pixels[x+y*4] = Color{R: uint8(x), G: uint8(y), B: 7, A: 255}
		}
	}

	sub := im.ToNRGBARect(image.Rect(1, 1, 3, 3))
	if got, want := sub.Bounds(), image.Rect(0, 0, 2, 2); got != want {
		t.Fatalf("bounds = %v, want %v (the crop moved to the origin)", got, want)
	}
	// The crop must carry the source pixels, not a re-indexed copy of them.
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			o := y*sub.Stride + x*4
			if sub.Pix[o] != uint8(x+1) || sub.Pix[o+1] != uint8(y+1) {
				t.Errorf("crop pixel (%d,%d) = R%d G%d, want R%d G%d", x, y, sub.Pix[o], sub.Pix[o+1], x+1, y+1)
			}
		}
	}

	// The full rect must agree with ToNRGBA, which is the path it replaces.
	full := im.ToNRGBARect(image.Rect(0, 0, 4, 3))
	want := im.ToNRGBA()
	if full.Bounds() != want.Bounds() {
		t.Fatalf("full bounds = %v, want %v", full.Bounds(), want.Bounds())
	}
	for i := range want.Pix {
		if full.Pix[i] != want.Pix[i] {
			t.Fatalf("full crop differs from ToNRGBA at byte %d", i)
		}
	}
}

// TestToNRGBARectClamps covers a rect reaching past the image: it is clipped
// rather than reading out of bounds.
func TestToNRGBARectClamps(t *testing.T) {
	im := solidRaw(2, 2, Color{R: 9, A: 255})
	sub := im.ToNRGBARect(image.Rect(1, 1, 40, 40))
	if got, want := sub.Bounds(), image.Rect(0, 0, 1, 1); got != want {
		t.Errorf("bounds = %v, want %v", got, want)
	}
	if sub.Pix[0] != 9 || sub.Pix[3] != 255 {
		t.Errorf("pixel = %v, want the source pixel", sub.Pix[:4])
	}
}
