package effect

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/png"
	"testing"
)

// build24BMP makes a 2×1 24-bit BI_RGB BMP: pixel (0,0) red, pixel (1,0) magenta.
func build24BMP() []byte {
	var b bytes.Buffer
	// BITMAPFILEHEADER (14) + BITMAPINFOHEADER (40) = 54; row = 6 bytes padded to 8.
	b.WriteString("BM")
	binary.Write(&b, binary.LittleEndian, uint32(62)) // file size
	binary.Write(&b, binary.LittleEndian, uint32(0))  // reserved
	binary.Write(&b, binary.LittleEndian, uint32(54)) // pixel data offset
	binary.Write(&b, binary.LittleEndian, uint32(40)) // DIB header size
	binary.Write(&b, binary.LittleEndian, int32(2))   // width
	binary.Write(&b, binary.LittleEndian, int32(1))   // height (bottom-up)
	binary.Write(&b, binary.LittleEndian, uint16(1))  // planes
	binary.Write(&b, binary.LittleEndian, uint16(24)) // bpp
	binary.Write(&b, binary.LittleEndian, uint32(0))  // compression BI_RGB
	binary.Write(&b, binary.LittleEndian, uint32(0))  // image size
	binary.Write(&b, binary.LittleEndian, int32(0))   // xppm
	binary.Write(&b, binary.LittleEndian, int32(0))   // yppm
	binary.Write(&b, binary.LittleEndian, uint32(0))  // clrUsed
	binary.Write(&b, binary.LittleEndian, uint32(0))  // clrImportant
	// pixel row (BGR), padded to 4 bytes: red then magenta.
	b.Write([]byte{0x00, 0x00, 0xFF}) // red   (B,G,R)
	b.Write([]byte{0xFF, 0x00, 0xFF}) // magenta
	b.Write([]byte{0x00, 0x00})       // padding to 8 bytes
	return b.Bytes()
}

// build32TGA makes a 1×1 top-down 32-bit uncompressed TGA with a real alpha.
func build32TGA() []byte {
	h := make([]byte, 18)
	h[2] = 2     // uncompressed truecolor
	h[12] = 1    // width lo
	h[14] = 1    // height lo
	h[16] = 32   // bpp
	h[17] = 0x20 // top-down origin
	// one pixel, stored BGRA: B=30 G=20 R=10 A=128
	return append(h, 30, 20, 10, 128)
}

func decodeNRGBA(t *testing.T, pngBytes []byte) *image.NRGBA {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		t.Fatalf("png.Decode: %v", err)
	}
	nrgba, ok := img.(*image.NRGBA)
	if !ok {
		t.Fatalf("decoded image is %T, want *image.NRGBA", img)
	}
	return nrgba
}

func TestTextureBMPColorkey(t *testing.T) {
	out, err := TextureToPNG(build24BMP(), "fire.bmp")
	if err != nil {
		t.Fatalf("TextureToPNG: %v", err)
	}
	img := decodeNRGBA(t, out)
	if img.Bounds().Dx() != 2 || img.Bounds().Dy() != 1 {
		t.Fatalf("size = %v", img.Bounds())
	}
	// Pixel 0: opaque red.
	if got := img.Pix[0:4]; got[0] != 255 || got[1] != 0 || got[2] != 0 || got[3] != 255 {
		t.Errorf("pixel0 = %v, want red opaque [255 0 0 255]", got)
	}
	// Pixel 1: the magenta colorkey → alpha 0, and its RGB is bled from the
	// opaque red neighbour (not left magenta/black → no bilinear fringe).
	if got := img.Pix[4:8]; got[3] != 0 {
		t.Errorf("pixel1 alpha = %d, want 0 (colorkeyed)", got[3])
	}
	if got := img.Pix[4:8]; got[0] != 255 || got[1] != 0 || got[2] != 0 {
		t.Errorf("pixel1 RGB = %v, want bled red [255 0 0] (not magenta)", got[:3])
	}
}

func TestTextureTGAAlpha(t *testing.T) {
	out, err := TextureToPNG(build32TGA(), "glow.tga")
	if err != nil {
		t.Fatalf("TextureToPNG: %v", err)
	}
	img := decodeNRGBA(t, out)
	if got := img.Pix[0:4]; got[0] != 10 || got[1] != 20 || got[2] != 30 || got[3] != 128 {
		t.Errorf("pixel = %v, want [10 20 30 128] (real TGA alpha preserved)", got)
	}
}

func TestTextureUnsupported(t *testing.T) {
	if _, err := TextureToPNG([]byte("not an image"), "x.bmp"); err == nil {
		t.Fatal("want error for undecodable BMP")
	}
}
