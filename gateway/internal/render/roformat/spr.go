package roformat

import (
	"errors"
	"fmt"

	"github.com/ragassets/gateway/internal/render/raster"
)

// Palette is a 256-entry RGBA color table.
type Palette []raster.Color

const minSprSize = 2 + 6 + 1024

// sprImage is a parsed SPR image header: its dimensions and the byte offset of
// its pixel data within the file buffer. Pixels are decoded on demand.
type sprImage struct {
	width, height int
	dataOffset    int
}

// Spr is a parsed .spr file. SprType 0 holds palette-indexed images, SprType 1
// holds direct RGBA images (only present for ver≥0x200). The embedded palette is
// the last 1024 bytes of the file; an external palette may override it at decode.
type Spr struct {
	Ver     uint16
	palette Palette
	images  [2][]sprImage // [0]=indexed, [1]=rgba
	buf     []byte
}

// ParseSpr parses a .spr file buffer.
func ParseSpr(buf []byte) (*Spr, error) {
	if len(buf) < minSprSize {
		return nil, fmt.Errorf("spr: too small (%d bytes, need >= %d)", len(buf), minSprSize)
	}
	if buf[0] != 'S' || buf[1] != 'P' {
		return nil, errors.New("spr: bad signature (expected 'SP')")
	}

	s := &Spr{buf: buf}

	// Palette: last 1024 bytes, 256 entries of [R,G,B,A].
	s.palette = parsePaletteBytes(buf[len(buf)-1024:])

	r := newReader(buf)
	r.skip(2) // signature
	s.Ver = r.u16()
	palImages := int(r.u16())
	rgbaImages := 0
	if s.Ver >= 0x200 {
		rgbaImages = int(r.u16())
	}

	s.images[0] = make([]sprImage, palImages)
	for i := 0; i < palImages; i++ {
		img := sprImage{width: int(r.u16()), height: int(r.u16())}
		size := img.width * img.height
		img.dataOffset = r.off
		if s.Ver >= 0x201 {
			// RLE-encoded; a u16 size prefix precedes the data. dataOffset points
			// at that prefix so DecodeImage can re-read it.
			size = int(r.u16())
		}
		s.images[0][i] = img
		r.skip(size)
	}

	if s.Ver >= 0x200 {
		s.images[1] = make([]sprImage, rgbaImages)
		for i := 0; i < rgbaImages; i++ {
			img := sprImage{width: int(r.u16()), height: int(r.u16())}
			img.dataOffset = r.off
			s.images[1][i] = img
			r.skip(img.width * img.height * 4)
		}
	}

	if r.err != nil {
		return nil, r.err
	}
	return s, nil
}

// Palette returns the SPR's embedded palette.
func (s *Spr) Palette() Palette { return s.palette }

// ImageCount returns the number of images of the given sprType (0 or 1).
func (s *Spr) ImageCount(sprType int) int {
	if sprType < 0 || sprType > 1 {
		return 0
	}
	return len(s.images[sprType])
}

// ImageSize returns the width/height of an image, or (0,0) if out of range.
func (s *Spr) ImageSize(index, sprType int) (int, int) {
	if sprType < 0 || sprType > 1 || index < 0 || index >= len(s.images[sprType]) {
		return 0, 0
	}
	im := s.images[sprType][index]
	return im.width, im.height
}

// DecodeImage decodes one image to a RawImage. For indexed images (sprType 0)
// the supplied palette overrides the embedded one when non-nil; palette index 0
// always decodes to a transparent pixel. Returns the empty RawImage when the
// index/type is out of range. This is a pure decode (no caching).
func (s *Spr) DecodeImage(index, sprType int, pal Palette) raster.RawImage {
	if sprType < 0 || sprType > 1 || index < 0 || index >= len(s.images[sprType]) {
		return raster.RawImage{}
	}
	im := s.images[sprType][index]
	if im.width <= 0 || im.height <= 0 {
		return raster.RawImage{}
	}
	out := raster.NewRawImage(im.width, im.height)

	if sprType == 0 {
		p := pal
		if p == nil {
			p = s.palette
		}
		s.decodeIndexed(im, p, out.Pixels)
	} else {
		s.decodeRGBA(im, out.Pixels)
	}
	return out
}

// decodeIndexed fills dst from a palette-indexed image. ver≥0x201 images are RLE
// compressed: a byte of 0 starts a run whose length is the following byte (those
// pixels are transparent); any other byte is a literal palette index. Index 0 is
// always transparent; other indices are fully opaque (palette alpha ignored).
func (s *Spr) decodeIndexed(im sprImage, pal Palette, dst []raster.Color) {
	off := im.dataOffset
	n := len(dst)

	color := func(idx byte) raster.Color {
		var c raster.Color
		if int(idx) < len(pal) {
			c = pal[idx]
		}
		if idx == 0 {
			c.A = 0
		} else {
			c.A = 0xFF
		}
		return c
	}

	if s.Ver >= 0x201 {
		size := int(uint16(s.buf[off]) | uint16(s.buf[off+1])<<8)
		off += 2
		end := off + size
		p := 0
		for j := off; j < end && p < n; j++ {
			idx := s.buf[j]
			if idx == 0 {
				// Run of transparent pixels.
				if j+1 >= end {
					break
				}
				runLen := int(s.buf[j+1])
				j++
				transparent := color(0)
				for k := 0; k < runLen && p < n; k++ {
					dst[p] = transparent
					p++
				}
			} else {
				dst[p] = color(idx)
				p++
			}
		}
		return
	}

	// Uncompressed: width*height palette indices.
	for p := 0; p < n; p++ {
		dst[p] = color(s.buf[off+p])
	}
}

// decodeRGBA fills dst from a direct-color image. zrenderer reads each 4-byte
// pixel big-endian then reinterprets it as 0xAABBGGRR, so the on-disk byte order
// is [A,B,G,R]. RGBA images are stored with a flipped Y axis (bottom-up), which
// we undo here.
func (s *Spr) decodeRGBA(im sprImage, dst []raster.Color) {
	off := im.dataOffset
	w := im.width
	n := len(dst)
	for p := 0; p < n; p++ {
		b0 := s.buf[off]
		b1 := s.buf[off+1]
		b2 := s.buf[off+2]
		b3 := s.buf[off+3]
		off += 4

		c := raster.Color{R: b3, G: b2, B: b1, A: b0}

		// Flip vertically: source row p/w from the top maps to the bottom.
		x := p % w
		y := (p / w) + 1
		dstIdx := n - (y * w) + x
		if dstIdx >= 0 && dstIdx < n {
			dst[dstIdx] = c
		}
	}
}

// parsePaletteBytes interprets a 1024-byte block as 256 [R,G,B,A] entries.
func parsePaletteBytes(b []byte) Palette {
	pal := make(Palette, 256)
	for i := 0; i < 256; i++ {
		o := i * 4
		pal[i] = raster.Color{R: b[o], G: b[o+1], B: b[o+2], A: b[o+3]}
	}
	return pal
}
