package roformat

import "testing"

func TestParseImf(t *testing.T) {
	// 2 layers (maxLayer=1). Layer 0: 1 action, 2 frames (priorities 0,1).
	// Layer 1: 1 action, 1 frame (priority 5).
	w := &leBuf{}
	w.f32(1.01) // ver
	w.u32(0)    // checksum
	w.u32(1)    // maxLayer => 2 layers
	// layer 0:
	w.u32(1) // numActions
	w.u32(2) // numFrames
	w.i32(0).zeros(8)
	w.i32(1).zeros(8)
	// layer 1:
	w.u32(1) // numActions
	w.u32(1) // numFrames
	w.i32(5).zeros(8)

	m, err := ParseImf(w.b)
	if err != nil {
		t.Fatalf("ParseImf: %v", err)
	}
	if got := m.Priority(0, 0, 0); got != 0 {
		t.Errorf("priority(0,0,0) = %d, want 0", got)
	}
	if got := m.Priority(0, 0, 1); got != 1 {
		t.Errorf("priority(0,0,1) = %d, want 1", got)
	}
	if got := m.Priority(1, 0, 0); got != 5 {
		t.Errorf("priority(1,0,0) = %d, want 5", got)
	}
	// Out-of-range -> -1.
	if got := m.Priority(9, 0, 0); got != -1 {
		t.Errorf("priority(9,0,0) = %d, want -1", got)
	}
	if got := m.Priority(0, 0, 99); got != -1 {
		t.Errorf("priority(0,0,99) = %d, want -1", got)
	}
}

func TestImfNilSafe(t *testing.T) {
	var m *Imf
	if got := m.Priority(1, 0, 0); got != -1 {
		t.Errorf("nil imf priority = %d, want -1", got)
	}
}

func TestParseImf_RealFile(t *testing.T) {
	path := repoFile(t, "resources/data/imf/검사_남.imf")
	m, err := ParseImf(mustRead(t, path))
	if err != nil {
		t.Fatalf("ParseImf(real): %v", err)
	}
	// Just ensure a lookup on the head layer (1) doesn't panic and returns a value.
	_ = m.Priority(1, 0, 0)
}
