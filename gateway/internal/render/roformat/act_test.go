package roformat

import (
	"testing"

	"github.com/ragassets/gateway/internal/render/raster"
)

func TestParseAct_V205(t *testing.T) {
	w := &leBuf{}
	w.str("AC").u16(0x205).u16(1).zeros(10) // sig, ver, numActions=1, reserved
	w.u32(1)                                // action 0: 1 frame
	// frame:
	w.zeros(8 * 4) // attackRange + fitRange
	w.u32(1)       // 1 sprite
	// sprite:
	w.i32(-5).i32(7).i32(3) // x,y,sprId
	w.u32(1)                // flags: mirrored
	w.u32(0xFF804020)       // tint AABBGGRR -> A=255,B=128,G=64,R=32
	w.f32(2.0)              // xScale
	w.f32(3.0)              // yScale (ver>=0x204)
	w.i32(90)               // rotation
	w.i32(0)                // sprType
	w.i32(11).i32(22)       // width,height (ver>=0x205)
	w.i32(42)               // eventId (ver>=0x200)
	// attach points (ver>=0x203):
	w.u32(1)                   // 1 attach point
	w.zeros(4)                 // reserved
	w.i32(100).i32(-50).i32(9) // x,y,attr
	// events (ver>=0x201):
	w.u32(0) // numEvents
	// per-action interval (ver>=0x202):
	w.f32(12.5)

	a, err := ParseAct(w.b)
	if err != nil {
		t.Fatalf("ParseAct: %v", err)
	}
	if len(a.Actions) != 1 {
		t.Fatalf("actions = %d, want 1", len(a.Actions))
	}
	if a.NumberOfFrames(0) != 1 {
		t.Fatalf("frames = %d, want 1", a.NumberOfFrames(0))
	}
	sprs := a.Sprites(0, 0)
	if len(sprs) != 1 {
		t.Fatalf("sprites = %d, want 1", len(sprs))
	}
	s := sprs[0]
	if s.X != -5 || s.Y != 7 || s.SprID != 3 {
		t.Errorf("x/y/sprId = %d/%d/%d, want -5/7/3", s.X, s.Y, s.SprID)
	}
	if !s.Mirrored() {
		t.Error("expected mirrored")
	}
	if s.Tint != (raster.Color{R: 32, G: 64, B: 128, A: 255}) {
		t.Errorf("tint = %+v, want {32 64 128 255}", s.Tint)
	}
	if s.XScale != 2.0 || s.YScale != 3.0 {
		t.Errorf("scale = %v/%v, want 2/3", s.XScale, s.YScale)
	}
	if s.Rotation != 90 || s.Width != 11 || s.Height != 22 {
		t.Errorf("rotation/w/h = %d/%d/%d, want 90/11/22", s.Rotation, s.Width, s.Height)
	}
	ap := a.AttachPoint(0, 0, 0)
	if ap.X != 100 || ap.Y != -50 || ap.Attr != 9 {
		t.Errorf("attach = %+v, want {100 -50 9}", ap)
	}
	if a.Interval(0) != 12.5 {
		t.Errorf("interval = %v, want 12.5", a.Interval(0))
	}
}

func TestParseAct_YScaleFallback(t *testing.T) {
	// ver 0x201: no separate yScale (mirrors xScale), no width/height, no attach
	// block (ver<0x203), and no per-action interval (ver<0x202 -> default 4).
	w := &leBuf{}
	w.str("AC").u16(0x201).u16(1).zeros(10)
	w.u32(1)       // 1 frame
	w.zeros(8 * 4) // ranges
	w.u32(1)       // 1 sprite
	w.i32(0).i32(0).i32(0).u32(0).u32(0xFFFFFFFF)
	w.f32(1.5)      // xScale (yScale mirrors it)
	w.i32(0).i32(0) // rotation, sprType
	w.i32(0)        // eventId (ver>=0x200)
	w.u32(0)        // numEvents (ver>=0x201)
	// no interval block (ver < 0x202)

	a, err := ParseAct(w.b)
	if err != nil {
		t.Fatalf("ParseAct: %v", err)
	}
	s := a.Sprites(0, 0)[0]
	if s.XScale != 1.5 || s.YScale != 1.5 {
		t.Errorf("scale = %v/%v, want 1.5/1.5", s.XScale, s.YScale)
	}
	if a.Interval(0) != 4 {
		t.Errorf("default interval = %v, want 4", a.Interval(0))
	}
}

func TestParseAct_Errors(t *testing.T) {
	if _, err := ParseAct([]byte{1, 2, 3}); err == nil {
		t.Error("expected error for too-small buffer")
	}
	bad := make([]byte, minActSize)
	bad[0], bad[1] = 'X', 'Y'
	if _, err := ParseAct(bad); err == nil {
		t.Error("expected error for bad signature")
	}
}

func TestParseAct_RealFile(t *testing.T) {
	path := repoFile(t, "resources/data/sprite/인간족/몸통/남/검사_남.act")
	a, err := ParseAct(mustRead(t, path))
	if err != nil {
		t.Fatalf("ParseAct(real): %v", err)
	}
	if len(a.Actions) == 0 {
		t.Fatal("real act has zero actions")
	}
	// Stand (action 0) should have frames with at least one sprite layer.
	if a.NumberOfFrames(0) == 0 {
		t.Fatal("stand action has zero frames")
	}
	if len(a.Sprites(0, 0)) == 0 {
		t.Error("stand frame 0 has zero sprite layers")
	}
}
