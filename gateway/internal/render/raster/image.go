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

// OpaqueBounds returns the smallest rectangle enclosing every pixel with a
// non-zero alpha, in image coordinates. It is empty when the image carries no
// visible pixel at all (a fully transparent frame, or the zero RawImage).
//
// A rendered sprite usually occupies a small part of its canvas — a request may
// ask for 320x320 to get a fixed frame around a body barely 55x110 — so this is
// what lets the APNG encoder compress the sprite instead of the padding.
func (im RawImage) OpaqueBounds() image.Rectangle {
	minX, minY := im.Width, im.Height
	maxX, maxY := -1, -1
	for y := 0; y < im.Height; y++ {
		row := im.Pixels[y*im.Width : (y+1)*im.Width]
		for x, c := range row {
			if c.A == 0 {
				continue
			}
			if x < minX {
				minX = x
			}
			if x > maxX {
				maxX = x
			}
			if y < minY {
				minY = y
			}
			maxY = y // rows ascend, so the last row touched is the bottom
		}
	}
	if maxX < 0 {
		return image.Rectangle{}
	}
	return image.Rect(minX, minY, maxX+1, maxY+1)
}

// ToNRGBARect converts just the pixels inside r into an image.NRGBA whose own
// bounds start at the origin — the crop, moved to (0,0). r must lie within the
// image. It is ToNRGBA when r is the full bounds, minus the copying of pixels
// the caller does not want.
func (im RawImage) ToNRGBARect(r image.Rectangle) *image.NRGBA {
	r = r.Intersect(image.Rect(0, 0, im.Width, im.Height))
	out := image.NewNRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		src := im.Pixels[(y+r.Min.Y)*im.Width+r.Min.X:]
		o := y * out.Stride
		for x := 0; x < r.Dx(); x++ {
			c := src[x]
			out.Pix[o+0] = c.R
			out.Pix[o+1] = c.G
			out.Pix[o+2] = c.B
			out.Pix[o+3] = c.A
			o += 4
		}
	}
	return out
}
