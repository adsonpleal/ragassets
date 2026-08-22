package sprite

import (
	"encoding/binary"
	"testing"

	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/roformat"
	"github.com/ragassets/gateway/internal/render/rotype"
)

// tinySpr builds a valid 1x1 opaque (palette index 1) SPR for tests.
func tinySpr(t *testing.T) *roformat.Spr {
	t.Helper()
	var b []byte
	b = append(b, 'S', 'P')
	b = binary.LittleEndian.AppendUint16(b, 0x100) // ver
	b = binary.LittleEndian.AppendUint16(b, 1)     // palImages
	b = binary.LittleEndian.AppendUint16(b, 1)     // width
	b = binary.LittleEndian.AppendUint16(b, 1)     // height
	b = append(b, 1)                               // one pixel, palette index 1
	pal := make([]byte, 1024)
	pal[4], pal[5], pal[6], pal[7] = 200, 100, 50, 255 // palette[1]
	b = append(b, pal...)
	spr, err := roformat.ParseSpr(b)
	if err != nil {
		t.Fatalf("tinySpr: %v", err)
	}
	return spr
}

// standAct builds an ACT with one stand action (index 0) of n frames, each a
// single full-opaque sprite layer referencing SPR image 0.
func standAct(n int) *roformat.Act {
	frames := make([]roformat.ActFrame, n)
	for i := range frames {
		frames[i] = roformat.ActFrame{
			Sprites: []roformat.ActSprite{{
				SprID:   0,
				SprType: 0,
				Tint:    raster.Color{R: 255, G: 255, B: 255, A: 255},
				XScale:  1,
				YScale:  1,
			}},
		}
	}
	return &roformat.Act{Actions: []roformat.ActAction{{Interval: 4, Frames: frames}}}
}

func TestDrawObjectsOfAction_HeadDirSlicing(t *testing.T) {
	spr := tinySpr(t)
	act := standAct(3) // 3 frames (one per direction)

	cases := []struct {
		hd      rotype.HeadDirection
		wantLen int
	}{
		{rotype.All, 3},      // not sliced — cycles through all
		{rotype.Straight, 1}, // first third
		{rotype.Left, 1},
		{rotype.Right, 1},
	}
	for _, c := range cases {
		s := New(act, spr, TypePlayerHead)
		s.HeadDir = c.hd
		obj := s.DrawObjectsOfAction(0)
		if len(obj.Children) != c.wantLen {
			t.Errorf("headdir=%d: children=%d, want %d", c.hd, len(obj.Children), c.wantLen)
		}
	}
}

func TestDrawObjectsOfAction_NonHeadNotSliced(t *testing.T) {
	// A body (non-head/accessory) is never sliced by head direction.
	s := New(standAct(3), tinySpr(t), TypePlayerBody)
	s.HeadDir = rotype.Straight
	if got := len(s.DrawObjectsOfAction(0).Children); got != 3 {
		t.Errorf("body children = %d, want 3 (no slicing)", got)
	}
}

func TestImageCaching(t *testing.T) {
	s := New(standAct(1), tinySpr(t), TypePlayerHead)
	img := s.Image(0, 0)
	if img.Empty() {
		t.Fatal("decoded image empty")
	}
	if img.Pixels[0] != (raster.Color{R: 200, G: 100, B: 50, A: 255}) {
		t.Errorf("pixel = %+v", img.Pixels[0])
	}
	// Out-of-range image id is empty.
	if !s.Image(99, 0).Empty() {
		t.Error("expected empty image for out-of-range id")
	}
}

// wideSpr builds a 2x2 SPR: indices [1,2,0,1] — one transparent pixel at offset 2.
func wideSpr(t *testing.T) *roformat.Spr {
	t.Helper()
	var b []byte
	b = append(b, 'S', 'P')
	b = binary.LittleEndian.AppendUint16(b, 0x100)
	b = binary.LittleEndian.AppendUint16(b, 1)
	b = binary.LittleEndian.AppendUint16(b, 2) // width
	b = binary.LittleEndian.AppendUint16(b, 2) // height
	b = append(b, 1, 2, 0, 1)
	pal := make([]byte, 1024)
	pal[4], pal[5], pal[6], pal[7] = 200, 100, 50, 255 // palette[1]
	pal[8], pal[9], pal[10], pal[11] = 10, 20, 30, 255 // palette[2]
	b = append(b, pal...)
	spr, err := roformat.ParseSpr(b)
	if err != nil {
		t.Fatalf("wideSpr: %v", err)
	}
	return spr
}

func TestImagePixelOverride(t *testing.T) {
	paint := raster.Color{R: 1, G: 2, B: 3, A: 255}
	s := New(standAct(1), wideSpr(t), TypePlayerHead)
	s.PixelOverrides = map[int][]PixelRun{
		0: {{Color: paint, Offsets: []int32{1, 2, 99, -1}}},
	}

	img := s.Image(0, 0)
	if img.Pixels[1] != paint {
		t.Errorf("offset 1 = %+v, want the override colour", img.Pixels[1])
	}
	// Offset 0 is not listed; offset 2 is transparent; 99 and -1 are out of range.
	if got := (raster.Color{R: 200, G: 100, B: 50, A: 255}); img.Pixels[0] != got {
		t.Errorf("offset 0 = %+v, want it untouched (%+v)", img.Pixels[0], got)
	}
	if img.Pixels[2].A != 0 {
		t.Errorf("offset 2 = %+v, want a transparent pixel left alone", img.Pixels[2])
	}
	if img.Pixels[3] == paint {
		t.Error("offset 3 was painted but was not listed")
	}

	// The cached image must already carry the override.
	if again := s.Image(0, 0); again.Pixels[1] != paint {
		t.Error("second Image() call lost the override")
	}

	// A frame with no runs is untouched.
	s2 := New(standAct(1), wideSpr(t), TypePlayerHead)
	s2.PixelOverrides = map[int][]PixelRun{7: {{Color: paint, Offsets: []int32{0}}}}
	if s2.Image(0, 0).Pixels[0] == paint {
		t.Error("override for image 7 leaked into image 0")
	}

	// RGBA images (sprType 1) are never overridden.
	s3 := New(standAct(1), wideSpr(t), TypePlayerHead)
	s3.PixelOverrides = map[int][]PixelRun{0: {{Color: paint, Offsets: []int32{0}}}}
	if img := s3.Image(0, 1); !img.Empty() {
		t.Error("expected no rgba image in this fixture")
	}
}
