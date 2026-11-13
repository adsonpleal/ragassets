package effect

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"testing"
)

// buildStr assembles a minimal one-layer, one-keyframe STRM buffer for the parser
// tests, so no GRF-derived binary needs to be committed.
func buildStr() []byte {
	var b bytes.Buffer
	u32 := func(v uint32) { binary.Write(&b, binary.LittleEndian, v) }
	f32 := func(v float32) { u32(math.Float32bits(v)) }

	b.WriteString("STRM")
	u32(0x94)                 // version
	u32(60)                   // fps
	u32(100)                  // maxKey
	u32(1)                    // layerCount
	b.Write(make([]byte, 16)) // reserved

	// layer 0
	u32(2) // textureCount
	tex := func(name string) {
		field := make([]byte, 128)
		copy(field, name)
		b.Write(field)
	}
	tex("fire.bmp")
	tex("glow.tga")
	u32(1) // animCount
	// keyframe
	binary.Write(&b, binary.LittleEndian, int32(-3)) // frame
	u32(0)                                           // type
	f32(1.5)                                         // pos[0]
	f32(2.5)                                         // pos[1]
	for i := 0; i < 8; i++ {
		f32(float32(i)) // uv[0..7]
	}
	for i := 0; i < 8; i++ {
		f32(float32(10 + i)) // xy[0..7]
	}
	f32(0.75) // aniframe
	u32(0)    // anitype
	f32(4.0)  // delay
	f32(90.0) // angle
	f32(255)  // color r
	f32(128)  // color g
	f32(64)   // color b
	f32(255)  // color a
	u32(5)    // srcalpha (raw D3DBLEND)
	u32(2)    // destalpha (raw D3DBLEND)
	u32(7)    // mtpreset
	return b.Bytes()
}

func TestParseStr(t *testing.T) {
	str, err := ParseStr(buildStr())
	if err != nil {
		t.Fatalf("ParseStr: %v", err)
	}
	if str.FPS != 60 || str.MaxKey != 100 {
		t.Fatalf("header: fps=%d maxKey=%d", str.FPS, str.MaxKey)
	}
	if len(str.Layers) != 1 {
		t.Fatalf("want 1 layer, got %d", len(str.Layers))
	}
	ly := str.Layers[0]
	if len(ly.Textures) != 2 || ly.Textures[0] != "fire.bmp" || ly.Textures[1] != "glow.tga" {
		t.Fatalf("textures: %#v", ly.Textures)
	}
	if len(ly.Animations) != 1 {
		t.Fatalf("want 1 keyframe, got %d", len(ly.Animations))
	}
	k := ly.Animations[0]
	if k.Frame != -3 {
		t.Errorf("frame = %d, want -3", k.Frame)
	}
	if k.Pos != [2]float32{1.5, 2.5} {
		t.Errorf("pos = %v", k.Pos)
	}
	if k.UV != [8]float32{0, 1, 2, 3, 4, 5, 6, 7} {
		t.Errorf("uv = %v", k.UV)
	}
	if k.XY != [8]float32{10, 11, 12, 13, 14, 15, 16, 17} {
		t.Errorf("xy = %v", k.XY)
	}
	// The raw D3DBLEND ints and mtpreset must survive verbatim.
	if k.Srcalpha != 5 || k.Destalpha != 2 || k.Mtpreset != 7 {
		t.Errorf("blend: src=%d dst=%d mt=%d, want 5/2/7", k.Srcalpha, k.Destalpha, k.Mtpreset)
	}
	// Color stays in the file's 0–255 range (client normalizes).
	if k.Color != [4]float32{255, 128, 64, 255} {
		t.Errorf("color = %v, want [255 128 64 255]", k.Color)
	}
}

func TestParseStrJSONShape(t *testing.T) {
	str, err := ParseStr(buildStr())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(str)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"fps", "maxKey", "layers"} {
		if _, ok := m[key]; !ok {
			t.Errorf("top-level JSON missing %q", key)
		}
	}
	layers := m["layers"].([]any)
	layer := layers[0].(map[string]any)
	if _, ok := layer["textures"]; !ok {
		t.Error("layer missing textures")
	}
	anim := layer["animations"].([]any)[0].(map[string]any)
	for _, key := range []string{"frame", "type", "pos", "uv", "xy", "aniframe", "anitype", "delay", "angle", "color", "srcalpha", "destalpha", "mtpreset"} {
		if _, ok := anim[key]; !ok {
			t.Errorf("keyframe JSON missing %q", key)
		}
	}
}

func TestParseStrRejectsBadMagic(t *testing.T) {
	if _, err := ParseStr([]byte("NOPE1234")); err == nil {
		t.Fatal("want error for bad magic")
	}
	if _, err := ParseStr(nil); err == nil {
		t.Fatal("want error for empty input")
	}
}

func TestParseStrTruncated(t *testing.T) {
	full := buildStr()
	if _, err := ParseStr(full[:len(full)-20]); err == nil {
		t.Fatal("want EOF error for truncated STR")
	}
}

// buildStrNonFinite assembles the same one-layer STRM as buildStr, but with
// non-finite floats where real 4th-job *_bottom effects carry them: +Inf in
// pos[1], -Inf in xy[0], NaN in angle and NaN in the colour's alpha. The D3D
// client tolerates these; encoding/json refuses to marshal them, so the parser
// substitutes 0 rather than failing the file.
func buildStrNonFinite() []byte {
	var b bytes.Buffer
	u32 := func(v uint32) { binary.Write(&b, binary.LittleEndian, v) }
	f32 := func(v float32) { u32(math.Float32bits(v)) }
	inf := float32(math.Inf(1))
	negInf := float32(math.Inf(-1))
	nan := float32(math.NaN())

	b.WriteString("STRM")
	u32(0x94)                 // version
	u32(60)                   // fps
	u32(100)                  // maxKey
	u32(1)                    // layerCount
	b.Write(make([]byte, 16)) // reserved

	u32(1) // textureCount
	field := make([]byte, 128)
	copy(field, "ring_bottom.bmp")
	b.Write(field)

	u32(1)                                          // animCount
	binary.Write(&b, binary.LittleEndian, int32(0)) // frame
	u32(0)                                          // type
	f32(1.5)                                        // pos[0]
	f32(inf)                                        // pos[1]  — non-finite
	for i := 0; i < 8; i++ {
		f32(float32(i)) // uv[0..7]
	}
	f32(negInf) // xy[0]   — non-finite
	for i := 1; i < 8; i++ {
		f32(float32(10 + i)) // xy[1..7]
	}
	f32(0.75) // aniframe
	u32(0)    // anitype
	f32(4.0)  // delay
	f32(nan)  // angle    — non-finite
	f32(255)  // color r
	f32(128)  // color g
	f32(64)   // color b
	f32(nan)  // color a  — non-finite
	u32(5)    // srcalpha
	u32(2)    // destalpha
	u32(7)    // mtpreset
	return b.Bytes()
}

// TestParseStrNonFiniteFloats pins that a file carrying Inf/-Inf/NaN parses,
// marshals and keeps every other field — the keyframe, the layer and the file
// are not dropped, only the offending floats become 0.
func TestParseStrNonFiniteFloats(t *testing.T) {
	str, err := ParseStr(buildStrNonFinite())
	if err != nil {
		t.Fatalf("ParseStr: %v", err)
	}
	if str.Sanitized != 4 {
		t.Errorf("Sanitized = %d, want 4", str.Sanitized)
	}
	if len(str.Layers) != 1 || len(str.Layers[0].Animations) != 1 {
		t.Fatalf("layers/keyframes dropped: %d layer(s)", len(str.Layers))
	}
	k := str.Layers[0].Animations[0]
	if k.Pos != [2]float32{1.5, 0} {
		t.Errorf("pos = %v, want [1.5 0]", k.Pos)
	}
	if k.XY != [8]float32{0, 11, 12, 13, 14, 15, 16, 17} {
		t.Errorf("xy = %v, want [0 11 12 13 14 15 16 17]", k.XY)
	}
	if k.Angle != 0 {
		t.Errorf("angle = %v, want 0", k.Angle)
	}
	if k.Color != [4]float32{255, 128, 64, 0} {
		t.Errorf("color = %v, want [255 128 64 0]", k.Color)
	}
	// The finite fields and the raw blend ints are untouched.
	if k.UV != [8]float32{0, 1, 2, 3, 4, 5, 6, 7} {
		t.Errorf("uv = %v", k.UV)
	}
	if k.Aniframe != 0.75 || k.Delay != 4 {
		t.Errorf("aniframe = %v, delay = %v", k.Aniframe, k.Delay)
	}
	if k.Srcalpha != 5 || k.Destalpha != 2 || k.Mtpreset != 7 {
		t.Errorf("blend: src=%d dst=%d mt=%d, want 5/2/7", k.Srcalpha, k.Destalpha, k.Mtpreset)
	}

	raw, err := json.Marshal(str)
	if err != nil {
		t.Fatalf("Marshal: %v", err) // the bug: "json: unsupported value: +Inf"
	}
	if bytes.Contains(raw, []byte("Inf")) || bytes.Contains(raw, []byte("NaN")) {
		t.Errorf("JSON carries a non-finite literal: %s", raw)
	}
	// Sanitized must not leak into the client contract.
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(m) != 3 {
		t.Errorf("top-level JSON keys = %v, want exactly fps/maxKey/layers", m)
	}
}
