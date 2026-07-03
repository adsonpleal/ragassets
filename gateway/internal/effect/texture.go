package effect

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"strings"
)

// rgbaImage is a decoded texture: a width×height RGBA buffer (row-major, top-down)
// plus the count of magenta-keyed texels, used to keep the decoders' output shape
// identical to extract-grf.mjs's bmpToRgba/tgaToRgba.
type rgbaImage struct {
	w, h    int
	rgba    []byte // len = w*h*4
	magenta int
}

// TextureToPNG converts a .str-referenced BMP or TGA to a transparent RGBA PNG.
// BMP uses the magenta (#FF00FF) colorkey; 32-bit TGA keeps its real alpha. Both
// then have their transparent texels' RGB bled outward so bilinear filtering /
// mipmaps in the client don't pull magenta/black fringes back in. The extension
// (from name) selects the decoder. Mirrors extract-grf.mjs effectTextureToPng so
// the bytes match the existing /effects texture pipeline. Returns an error for
// unsupported encodings (caller 404s).
func TextureToPNG(data []byte, name string) ([]byte, error) {
	var img *rgbaImage
	if strings.HasSuffix(strings.ToLower(name), ".tga") {
		img = tgaToRGBA(data)
	} else {
		img = bmpToRGBA(data)
	}
	if img == nil {
		return nil, fmt.Errorf("effect: unsupported/undecodable texture %q", name)
	}
	bleedTransparent(img)
	return encodePNG(img)
}

// encodePNG writes the buffer as a truecolor+alpha (colorType 6) PNG, always
// keeping the alpha channel — the /effect/texture contract is "PNG (RGBA)", and
// the client's StrEffect uploads these as RGBA textures. The stdlib png encoder
// drops the alpha channel (colorType 2) for fully-opaque images (e.g. additive
// glow textures with no colorkey), so we encode directly, matching the vetted
// extract-grf.mjs pipeline (filter: none, one IDAT). Bytes need not be identical
// to that pipeline (zlib settings differ), but the RGBA layout is.
func encodePNG(img *rgbaImage) ([]byte, error) {
	var out bytes.Buffer
	out.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})

	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], uint32(img.w))
	binary.BigEndian.PutUint32(ihdr[4:], uint32(img.h))
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type: truecolor with alpha (RGBA)
	// ihdr[10..12] compression/filter/interlace = 0
	writePNGChunk(&out, "IHDR", ihdr)

	stride := img.w * 4
	raw := make([]byte, (stride+1)*img.h)
	for y := 0; y < img.h; y++ {
		// filter byte 0 (none), then the row's RGBA bytes.
		copy(raw[y*(stride+1)+1:], img.rgba[y*stride:y*stride+stride])
	}
	var idat bytes.Buffer
	zw := zlib.NewWriter(&idat)
	if _, err := zw.Write(raw); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	writePNGChunk(&out, "IDAT", idat.Bytes())
	writePNGChunk(&out, "IEND", nil)
	return out.Bytes(), nil
}

func writePNGChunk(out *bytes.Buffer, typ string, data []byte) {
	var lenb [4]byte
	binary.BigEndian.PutUint32(lenb[:], uint32(len(data)))
	out.Write(lenb[:])
	body := append([]byte(typ), data...)
	out.Write(body)
	var crcb [4]byte
	binary.BigEndian.PutUint32(crcb[:], crc32.ChecksumIEEE(body))
	out.Write(crcb[:])
}

// bmpToRGBA decodes an uncompressed (BI_RGB) Windows BMP — 1/4/8-bit palettized
// or 24/32-bit truecolor — into top-down RGBA, keying magenta (#FF00FF) to alpha
// 0. 32-bit BMPs ignore their stored alpha (the client uses the colorkey). Ported
// from extract-grf.mjs bmpToRgba. Returns nil for unsupported encodings.
func bmpToRGBA(b []byte) *rgbaImage {
	if len(b) < 54 || b[0] != 'B' || b[1] != 'M' {
		return nil
	}
	dataOffset := int(binary.LittleEndian.Uint32(b[10:]))
	dibSize := int(binary.LittleEndian.Uint32(b[14:]))
	w := int(int32(binary.LittleEndian.Uint32(b[18:])))
	rawH := int(int32(binary.LittleEndian.Uint32(b[22:])))
	bpp := int(binary.LittleEndian.Uint16(b[28:]))
	compression := binary.LittleEndian.Uint32(b[30:])
	if compression != 0 || w <= 0 || rawH == 0 { // BI_RGB only
		return nil
	}
	topDown := rawH < 0
	h := rawH
	if h < 0 {
		h = -h
	}

	var palette [][3]byte
	if bpp <= 8 {
		palCount := int(binary.LittleEndian.Uint32(b[46:])) // biClrUsed
		if palCount == 0 {
			palCount = 1 << bpp
		}
		palStart := 14 + dibSize
		palette = make([][3]byte, palCount)
		for i := 0; i < palCount; i++ {
			o := palStart + i*4 // stored BGRA
			if o+2 >= len(b) {
				break
			}
			palette[i] = [3]byte{b[o+2], b[o+1], b[o]}
		}
	} else if bpp != 24 && bpp != 32 {
		return nil
	}

	rowSize := ((bpp*w + 31) / 32) * 4 // padded to 4 bytes
	img := &rgbaImage{w: w, h: h, rgba: make([]byte, w*h*4)}
	for row := 0; row < h; row++ {
		srcRow := row
		if !topDown {
			srcRow = h - 1 - row // BMP rows are bottom-up
		}
		srcBase := dataOffset + srcRow*rowSize
		for x := 0; x < w; x++ {
			var r, g, bl byte
			switch bpp {
			case 8:
				r, g, bl = palLookup(palette, int(at(b, srcBase+x)))
			case 4:
				byteV := at(b, srcBase+(x>>1))
				idx := int(byteV >> 4)
				if x&1 == 1 {
					idx = int(byteV & 0x0f)
				}
				r, g, bl = palLookup(palette, idx)
			case 1:
				byteV := at(b, srcBase+(x>>3))
				idx := int((byteV >> (7 - uint(x&7))) & 1)
				r, g, bl = palLookup(palette, idx)
			case 24:
				o := srcBase + x*3
				bl, g, r = at(b, o), at(b, o+1), at(b, o+2)
			default: // 32bpp BGRA — ignore stored alpha
				o := srcBase + x*4
				bl, g, r = at(b, o), at(b, o+1), at(b, o+2)
			}
			di := (row*w + x) * 4
			img.rgba[di] = r
			img.rgba[di+1] = g
			img.rgba[di+2] = bl
			if r == 255 && g == 0 && bl == 255 { // magenta key
				img.magenta++
				img.rgba[di+3] = 0
			} else {
				img.rgba[di+3] = 255
			}
		}
	}
	return img
}

// at returns b[i] or 0 when out of range (matches the JS decoder's forgiving
// reads of truncated/mis-sized bitmaps).
func at(b []byte, i int) byte {
	if i < 0 || i >= len(b) {
		return 0
	}
	return b[i]
}

func palLookup(pal [][3]byte, i int) (byte, byte, byte) {
	if i < 0 || i >= len(pal) {
		return 0, 0, 0
	}
	return pal[i][0], pal[i][1], pal[i][2]
}

// tgaToRGBA decodes an uncompressed (type 2) or RLE (type 10) truecolor TGA —
// 24-bit opaque or 32-bit with a real alpha channel — into top-down RGBA. Ported
// from extract-grf.mjs tgaToRgba. Returns nil for unsupported encodings.
func tgaToRGBA(b []byte) *rgbaImage {
	if len(b) < 18 {
		return nil
	}
	idLen := int(b[0])
	colorMapType := b[1]
	imageType := b[2]
	if colorMapType != 0 || (imageType != 2 && imageType != 10) {
		return nil
	}
	w := int(binary.LittleEndian.Uint16(b[12:]))
	h := int(binary.LittleEndian.Uint16(b[14:]))
	bpp := int(b[16])
	desc := b[17]
	if w <= 0 || h <= 0 || (bpp != 24 && bpp != 32) {
		return nil
	}
	bytesPP := bpp / 8
	topDown := desc&0x20 != 0 // bit 5: 1 = top-left origin
	p := 18 + idLen           // no color map, so skip only the image-id field
	px := w * h
	src := make([]byte, px*bytesPP) // pixels in stored (row) order

	if imageType == 2 {
		if p+px*bytesPP > len(b) {
			return nil
		}
		copy(src, b[p:p+px*bytesPP])
	} else { // RLE: alternating run-length (0x80 bit) and raw packets
		o := 0
		for o < len(src) && p < len(b) {
			count := int(b[p]&0x7f) + 1
			rle := b[p]&0x80 != 0
			p++
			if rle {
				for i := 0; i < count && o < len(src); i++ {
					if p+bytesPP <= len(b) {
						copy(src[o:o+bytesPP], b[p:p+bytesPP])
					}
					o += bytesPP
				}
				p += bytesPP
			} else {
				n := count * bytesPP
				if p+n <= len(b) && o+n <= len(src) {
					copy(src[o:o+n], b[p:p+n])
				}
				o += n
				p += n
			}
		}
	}

	img := &rgbaImage{w: w, h: h, rgba: make([]byte, px*4)}
	for row := 0; row < h; row++ {
		srcRow := row
		if !topDown {
			srcRow = h - 1 - row
		}
		for x := 0; x < w; x++ {
			so := (srcRow*w + x) * bytesPP
			di := (row*w + x) * 4
			img.rgba[di] = at(src, so+2) // stored BGR(A)
			img.rgba[di+1] = at(src, so+1)
			img.rgba[di+2] = at(src, so)
			if bpp == 32 {
				img.rgba[di+3] = at(src, so+3)
			} else {
				img.rgba[di+3] = 255
			}
		}
	}
	return img
}

// bleedTransparent copies each transparent texel's RGB from its nearest opaque
// neighbour (multi-source BFS), leaving alpha at 0. The magenta colorkey and TGA
// glow edges otherwise leave transparent texels carrying magenta/black RGB that
// bleed back as fringes under bilinear filtering. Ported from extract-grf.mjs.
func bleedTransparent(img *rgbaImage) {
	total := img.w * img.h
	filled := make([]bool, total)
	queue := make([]int, 0, total)
	for i := 0; i < total; i++ {
		if img.rgba[i*4+3] != 0 {
			filled[i] = true
			queue = append(queue, i)
		}
	}
	if len(queue) == 0 || len(queue) == total { // all/none transparent
		return
	}
	for len(queue) > 0 {
		next := queue[:0:0]
		for _, p := range queue {
			px := p % img.w
			po := p * 4
			if px > 0 {
				bleedTo(img, filled, &next, p-1, po)
			}
			if px < img.w-1 {
				bleedTo(img, filled, &next, p+1, po)
			}
			if p-img.w >= 0 {
				bleedTo(img, filled, &next, p-img.w, po)
			}
			if p+img.w < total {
				bleedTo(img, filled, &next, p+img.w, po)
			}
		}
		queue = next
	}
}

func bleedTo(img *rgbaImage, filled []bool, next *[]int, q, po int) {
	if filled[q] {
		return
	}
	filled[q] = true
	qo := q * 4
	img.rgba[qo] = img.rgba[po]
	img.rgba[qo+1] = img.rgba[po+1]
	img.rgba[qo+2] = img.rgba[po+2] // copy RGB only; alpha stays 0
	*next = append(*next, q)
}
