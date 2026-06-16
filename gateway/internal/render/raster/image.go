package raster

import "image"

// RawImage is a width×height RGBA buffer in row-major order (pixels[x + y*width]).
// It is zrenderer's draw.RawImage. The zero value (nil pixels, 0 size) is the
// "empty / missing" image and is treated as absent by callers.
type RawImage struct {
	Width  int
	Height int
	Pixels []Color
}

// Empty reports whether the image carries no pixel data.
func (im RawImage) Empty() bool { return len(im.Pixels) == 0 || im.Width == 0 || im.Height == 0 }

// NewRawImage allocates a transparent (all-zero) image of the given size.
func NewRawImage(w, h int) RawImage {
	if w <= 0 || h <= 0 {
		return RawImage{}
	}
	return RawImage{Width: w, Height: h, Pixels: make([]Color, w*h)}
}

// At returns the pixel at (x,y), or a transparent pixel when out of bounds.
func (im RawImage) At(x, y int) Color {
	if x < 0 || y < 0 || x >= im.Width || y >= im.Height {
		return Color{}
	}
	return im.Pixels[x+y*im.Width]
}

// ToNRGBA converts the buffer into a standard library image.NRGBA for encoding.
// RawImage already stores non-premultiplied RGBA, so the channels map directly.
func (im RawImage) ToNRGBA() *image.NRGBA {
	out := image.NewNRGBA(image.Rect(0, 0, im.Width, im.Height))
	for i, c := range im.Pixels {
		o := i * 4
		out.Pix[o+0] = c.R
		out.Pix[o+1] = c.G
		out.Pix[o+2] = c.B
		out.Pix[o+3] = c.A
	}
	return out
}
