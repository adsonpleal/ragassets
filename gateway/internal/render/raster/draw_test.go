package raster

import (
	"testing"

	"github.com/ragassets/zrenderer-gateway/internal/render/geom"
)

func TestDrawSprite_IdentityOffset(t *testing.T) {
	// 2x2 source with distinct colors.
	src := NewRawImage(2, 2)
	red := Color{R: 255, A: 255}
	green := Color{G: 255, A: 255}
	blue := Color{B: 255, A: 255}
	white := Color{R: 255, G: 255, B: 255, A: 255}
	src.Pixels[0] = red   // (0,0)
	src.Pixels[1] = green // (1,0)
	src.Pixels[2] = blue  // (0,1)
	src.Pixels[3] = white // (1,1)

	tr := geom.NewTransform()
	tr.Size = geom.Vec2{X: 2, Y: 2}
	tr.Calculate()
	obj := DrawObject{
		Tint:        white, // opaque white tint = no-op
		Transform:   tr,
		BoundingBox: tr.BoundingBox(),
	}

	dest := NewRawImage(4, 4)
	DrawSprite(&dest, obj, src, geom.Vec3{X: 1, Y: 1, Z: 0})

	// Source (x,y) lands at dest (x+1, y+1).
	checks := []struct {
		x, y int
		want Color
	}{
		{1, 1, red}, {2, 1, green}, {1, 2, blue}, {2, 2, white},
		{0, 0, Color{}}, {3, 3, Color{}}, // untouched
	}
	for _, c := range checks {
		if got := dest.At(c.x, c.y); got != c.want {
			t.Errorf("dest(%d,%d) = %+v, want %+v", c.x, c.y, got, c.want)
		}
	}
}

func TestDrawSprite_TransparentTintSkipped(t *testing.T) {
	src := NewRawImage(1, 1)
	src.Pixels[0] = Color{R: 255, A: 255}
	tr := geom.NewTransform()
	tr.Size = geom.Vec2{X: 1, Y: 1}
	tr.Calculate()
	obj := DrawObject{Tint: Color{}, Transform: tr, BoundingBox: tr.BoundingBox()}
	dest := NewRawImage(2, 2)
	DrawSprite(&dest, obj, src, geom.Vec3{})
	for _, p := range dest.Pixels {
		if p != (Color{}) {
			t.Errorf("transparent tint should draw nothing, got %+v", p)
		}
	}
}

func TestApplyBabyScaling(t *testing.T) {
	// 4x4 source; scale 0.5 -> 2x2, nearest-neighbour (src = dst*2).
	src := NewRawImage(4, 4)
	for i := range src.Pixels {
		src.Pixels[i] = Color{R: uint8(i), A: 255}
	}
	out := ApplyBabyScaling([]RawImage{src}, 0.5)
	if out[0].Width != 2 || out[0].Height != 2 {
		t.Fatalf("scaled size = %dx%d, want 2x2", out[0].Width, out[0].Height)
	}
	// dst(0,0)->src(0,0)=idx0 ; dst(1,0)->src(2,0)=idx2 ; dst(0,1)->src(0,2)=idx8 ; dst(1,1)->src(2,2)=idx10
	wantR := []uint8{0, 2, 8, 10}
	for i, w := range wantR {
		if out[0].Pixels[i].R != w {
			t.Errorf("scaled pixel %d R = %d, want %d", i, out[0].Pixels[i].R, w)
		}
	}
}

func TestApplyBabyScaling_NoopFactor1(t *testing.T) {
	src := NewRawImage(2, 2)
	out := ApplyBabyScaling([]RawImage{src}, 1.0)
	if out[0].Width != 2 || out[0].Height != 2 {
		t.Errorf("factor 1 should be a no-op, got %dx%d", out[0].Width, out[0].Height)
	}
}
