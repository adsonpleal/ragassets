package roformat

import (
	"testing"

	"github.com/ragassets/gateway/internal/render/raster"
)

func TestParseSpr_Uncompressed(t *testing.T) {
	// ver 0x100: one 2x2 indexed image with indices [0,1,2,3].
	pal := palette1024(map[int][4]byte{
		0: {1, 2, 3, 4},      // index 0 -> transparent regardless of stored alpha
		1: {10, 20, 30, 99},  // alpha forced to 255 on decode
		2: {40, 50, 60, 0},   // alpha forced to 255
		3: {70, 80, 90, 255}, // alpha forced to 255
	})
	w := &leBuf{}
	w.str("SP").u16(0x100).u16(1) // sig, ver, palImages=1
	w.u16(2).u16(2)               // image w=2,h=2
	w.bytes(0, 1, 2, 3)           // 4 palette indices
	w.b = append(w.b, pal...)

	s, err := ParseSpr(w.b)
	if err != nil {
		t.Fatalf("ParseSpr: %v", err)
	}
	if s.Ver != 0x100 {
		t.Errorf("Ver = %#x, want 0x100", s.Ver)
	}
	if got := s.ImageCount(0); got != 1 {
		t.Fatalf("ImageCount(0) = %d, want 1", got)
	}
	img := s.DecodeImage(0, 0, nil)
	if img.Width != 2 || img.Height != 2 {
		t.Fatalf("size = %dx%d, want 2x2", img.Width, img.Height)
	}
	want := []raster.Color{
		{R: 1, G: 2, B: 3, A: 0}, // idx 0 transparent
		{R: 10, G: 20, B: 30, A: 255},
		{R: 40, G: 50, B: 60, A: 255},
		{R: 70, G: 80, B: 90, A: 255},
	}
	for i, c := range want {
		if img.Pixels[i] != c {
			t.Errorf("pixel %d = %+v, want %+v", i, img.Pixels[i], c)
		}
	}
}

func TestParseSpr_RLE(t *testing.T) {
	// ver 0x201: one 2x2 RLE image: run of 2 transparent, then idx5, idx7.
	pal := palette1024(map[int][4]byte{
		5: {11, 22, 33, 1},
		7: {44, 55, 66, 1},
	})
	rle := []byte{0x00, 0x02, 0x05, 0x07} // 0,len=2 ; 5 ; 7
	w := &leBuf{}
	w.str("SP").u16(0x201).u16(1).u16(0) // sig, ver, palImages=1, rgbaImages=0
	w.u16(2).u16(2)                      // w,h
	w.u16(uint16(len(rle)))              // RLE size prefix
	w.bytes(rle...)
	w.b = append(w.b, pal...)

	s, err := ParseSpr(w.b)
	if err != nil {
		t.Fatalf("ParseSpr: %v", err)
	}
	img := s.DecodeImage(0, 0, nil)
	want := []raster.Color{
		{A: 0}, {A: 0},
		{R: 11, G: 22, B: 33, A: 255},
		{R: 44, G: 55, B: 66, A: 255},
	}
	for i, c := range want {
		if img.Pixels[i] != c {
			t.Errorf("pixel %d = %+v, want %+v", i, img.Pixels[i], c)
		}
	}
}

func TestParseSpr_RGBA_FlippedY(t *testing.T) {
	// ver 0x200: one 1x2 rgba image. On-disk bytes are [A,B,G,R] and rows are
	// stored bottom-up, so source px0 lands at the bottom row.
	pal := palette1024(nil)
	w := &leBuf{}
	w.str("SP").u16(0x200).u16(0).u16(1) // palImages=0, rgbaImages=1
	w.u16(1).u16(2)                      // w=1,h=2
	w.bytes(255, 10, 20, 30)             // src px0: A=255,B=10,G=20,R=30
	w.bytes(128, 40, 50, 60)             // src px1: A=128,B=40,G=50,R=60
	w.b = append(w.b, pal...)

	s, err := ParseSpr(w.b)
	if err != nil {
		t.Fatalf("ParseSpr: %v", err)
	}
	if got := s.ImageCount(1); got != 1 {
		t.Fatalf("ImageCount(1) = %d, want 1", got)
	}
	img := s.DecodeImage(0, 1, nil)
	// Vertical flip: src px0 -> dst[1] (bottom), src px1 -> dst[0] (top).
	want := []raster.Color{
		{R: 60, G: 50, B: 40, A: 128}, // top
		{R: 30, G: 20, B: 10, A: 255}, // bottom
	}
	for i, c := range want {
		if img.Pixels[i] != c {
			t.Errorf("pixel %d = %+v, want %+v", i, img.Pixels[i], c)
		}
	}
}

func TestParseSpr_PaletteOverride(t *testing.T) {
	pal := palette1024(map[int][4]byte{1: {1, 1, 1, 1}})
	w := &leBuf{}
	w.str("SP").u16(0x100).u16(1).u16(1).u16(1).bytes(1)
	w.b = append(w.b, pal...)
	s, err := ParseSpr(w.b)
	if err != nil {
		t.Fatalf("ParseSpr: %v", err)
	}
	override := make(Palette, 256)
	override[1] = raster.Color{R: 200, G: 100, B: 50, A: 7}
	img := s.DecodeImage(0, 0, override)
	if got := img.Pixels[0]; got != (raster.Color{R: 200, G: 100, B: 50, A: 255}) {
		t.Errorf("override pixel = %+v, want {200 100 50 255}", got)
	}
}

func TestParseSpr_Errors(t *testing.T) {
	if _, err := ParseSpr([]byte("XX")); err == nil {
		t.Error("expected error for too-small buffer")
	}
	bad := make([]byte, minSprSize)
	bad[0], bad[1] = 'X', 'Y'
	if _, err := ParseSpr(bad); err == nil {
		t.Error("expected error for bad signature")
	}
}

func TestParseSpr_RealFile(t *testing.T) {
	path := repoFile(t, "resources/data/sprite/인간족/몸통/남/검사_남.spr")
	s, err := ParseSpr(mustRead(t, path))
	if err != nil {
		t.Fatalf("ParseSpr(real): %v", err)
	}
	if s.ImageCount(0)+s.ImageCount(1) == 0 {
		t.Fatal("real spr decoded zero images")
	}
	// Decode the first image and sanity-check it has some opaque pixels.
	img := s.DecodeImage(0, 0, nil)
	if img.Empty() {
		t.Fatal("first image decoded empty")
	}
	opaque := 0
	for _, p := range img.Pixels {
		if p.A != 0 {
			opaque++
		}
	}
	if opaque == 0 {
		t.Error("first image fully transparent (suspicious)")
	}
}
