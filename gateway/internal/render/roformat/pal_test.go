package roformat

import (
	"testing"

	"github.com/ragassets/gateway/internal/render/raster"
)

func TestParsePal(t *testing.T) {
	buf := palette1024(map[int][4]byte{
		0:   {1, 2, 3, 4},
		255: {250, 251, 252, 253},
	})
	pal, err := ParsePal(buf)
	if err != nil {
		t.Fatalf("ParsePal: %v", err)
	}
	if len(pal) != 256 {
		t.Fatalf("len = %d, want 256", len(pal))
	}
	if pal[0] != (raster.Color{R: 1, G: 2, B: 3, A: 4}) {
		t.Errorf("pal[0] = %+v", pal[0])
	}
	if pal[255] != (raster.Color{R: 250, G: 251, B: 252, A: 253}) {
		t.Errorf("pal[255] = %+v", pal[255])
	}
}

func TestParsePal_TrailingBytesIgnored(t *testing.T) {
	buf := append(palette1024(nil), 0xAB, 0xCD) // some .pal files have trailing data
	if _, err := ParsePal(buf); err != nil {
		t.Fatalf("ParsePal with trailing bytes: %v", err)
	}
}

func TestParsePal_TooSmall(t *testing.T) {
	if _, err := ParsePal(make([]byte, 100)); err == nil {
		t.Error("expected error for too-small palette")
	}
}

func TestParsePal_RealFile(t *testing.T) {
	path := repoFile(t, "resources/data/palette/도람족/body/hanbok_남_0.pal")
	pal, err := ParsePal(mustRead(t, path))
	if err != nil {
		t.Fatalf("ParsePal(real): %v", err)
	}
	if len(pal) != 256 {
		t.Fatalf("len = %d, want 256", len(pal))
	}
}
