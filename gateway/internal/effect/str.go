// Package effect parses and serves Ragnarok Online skill/world "effect" assets
// for the .rrf replay viewer: the binary ".str" (STRM) layer animations and the
// BMP/TGA layer textures they reference (data/texture/effect/*). ragassets is a
// data+texture server here, not a renderer — the client ports roBrowser's
// StrEffect renderer and needs the per-keyframe blend fields intact, so the STR
// is exposed as structured JSON (raw D3DBLEND ints kept verbatim) and each
// texture as a colorkey-to-alpha PNG. Nothing is baked to a flat image.
package effect

import (
	"encoding/binary"
	"fmt"
	"math"

	"golang.org/x/text/encoding/korean"
)

// Str is a parsed ".str" world/skill effect: a stack of additive layers, each a
// list of texture names plus a keyframe track that animates a textured quad.
// The JSON shape is the /effect/str contract; field order/casing is deliberate.
type Str struct {
	FPS    uint32  `json:"fps"`
	MaxKey uint32  `json:"maxKey"`
	Layers []Layer `json:"layers"`
}

// Layer is one additive draw layer: the textures it may show and its keyframes.
type Layer struct {
	Textures   []string   `json:"textures"`
	Animations []Keyframe `json:"animations"`
}

// Keyframe is a single STR animation key. srcalpha/destalpha are the RAW
// D3DBLEND enum ints from the file (the client maps them to gl.blendFunc); they
// are never collapsed or reinterpreted here. color stays in the file's 0–255
// range (the client normalizes). pos/uv/xy are kept as fixed-length arrays so
// the client can index them exactly as roBrowser's Str loader does.
type Keyframe struct {
	Frame     int32      `json:"frame"`
	Type      uint32     `json:"type"`
	Pos       [2]float32 `json:"pos"`
	UV        [8]float32 `json:"uv"`
	XY        [8]float32 `json:"xy"`
	Aniframe  float32    `json:"aniframe"`
	Anitype   uint32     `json:"anitype"`
	Delay     float32    `json:"delay"`
	Angle     float32    `json:"angle"`
	Color     [4]float32 `json:"color"`
	Srcalpha  uint32     `json:"srcalpha"`
	Destalpha uint32     `json:"destalpha"`
	Mtpreset  uint32     `json:"mtpreset"`
}

// eucKR decodes the fixed-length, NUL-terminated EUC-KR texture-name fields the
// STR stores (Korean client paths); ASCII names pass through unchanged.
var eucKR = korean.EUCKR.NewDecoder()

// strReader is a little-endian forward cursor. Out-of-range reads latch err and
// return zero, so a run of reads is checked once (mirrors roformat's reader).
type strReader struct {
	buf []byte
	off int
	err error
}

func (r *strReader) need(n int) bool {
	if r.err != nil {
		return false
	}
	if r.off+n > len(r.buf) {
		r.err = fmt.Errorf("effect: unexpected EOF at offset %d (need %d, have %d)", r.off, n, len(r.buf)-r.off)
		return false
	}
	return true
}

func (r *strReader) u32() uint32 {
	if !r.need(4) {
		return 0
	}
	v := binary.LittleEndian.Uint32(r.buf[r.off:])
	r.off += 4
	return v
}

func (r *strReader) i32() int32 { return int32(r.u32()) }

func (r *strReader) f32() float32 { return math.Float32frombits(r.u32()) }

func (r *strReader) floats(n int) []float32 {
	out := make([]float32, n)
	for i := range out {
		out[i] = r.f32()
	}
	return out
}

func (r *strReader) skip(n int) {
	if r.need(n) {
		r.off += n
	}
}

// str reads a fixed-length field, trims at the first NUL and decodes EUC-KR.
func (r *strReader) str(n int) string {
	if !r.need(n) {
		return ""
	}
	field := r.buf[r.off : r.off+n]
	r.off += n
	end := 0
	for end < len(field) && field[end] != 0 {
		end++
	}
	if end == 0 {
		return ""
	}
	if s, err := eucKR.String(string(field[:end])); err == nil {
		return s
	}
	return string(field[:end]) // fall back to raw bytes if not valid EUC-KR
}

// ParseStr parses a binary ".str" (STRM) effect. Layout (little-endian): magic
// "STRM", version u32, fps u32, maxKey u32, layerCount u32, 16 reserved bytes;
// then per layer a texture-name list (128-byte fields) and a keyframe track (one
// 124-byte key each). Ported from roBrowser's Loaders/Str.js.
func ParseStr(data []byte) (*Str, error) {
	if len(data) < 4 || string(data[:4]) != "STRM" {
		return nil, fmt.Errorf("effect: bad STR magic (want STRM)")
	}
	r := &strReader{buf: data, off: 4}
	_ = r.u32() // version (0x94); not surfaced
	fps := r.u32()
	maxKey := r.u32()
	layerCount := r.u32()
	r.skip(16) // reserved

	if r.err != nil {
		return nil, r.err
	}
	// Guard against a corrupt/huge layer count before allocating.
	if layerCount > 1<<20 {
		return nil, fmt.Errorf("effect: implausible layer count %d", layerCount)
	}

	out := &Str{FPS: fps, MaxKey: maxKey, Layers: make([]Layer, 0, layerCount)}
	for l := uint32(0); l < layerCount; l++ {
		texCount := r.u32()
		if r.err != nil {
			return nil, r.err
		}
		if texCount > 1<<20 {
			return nil, fmt.Errorf("effect: implausible texture count %d in layer %d", texCount, l)
		}
		textures := make([]string, 0, texCount)
		for t := uint32(0); t < texCount; t++ {
			textures = append(textures, r.str(128))
		}
		animCount := r.u32()
		if r.err != nil {
			return nil, r.err
		}
		if animCount > 1<<24 {
			return nil, fmt.Errorf("effect: implausible anim count %d in layer %d", animCount, l)
		}
		anims := make([]Keyframe, 0, animCount)
		for a := uint32(0); a < animCount; a++ {
			var k Keyframe
			k.Frame = r.i32()
			k.Type = r.u32()
			copy(k.Pos[:], r.floats(2))
			copy(k.UV[:], r.floats(8))
			copy(k.XY[:], r.floats(8))
			k.Aniframe = r.f32()
			k.Anitype = r.u32()
			k.Delay = r.f32()
			k.Angle = r.f32()
			copy(k.Color[:], r.floats(4))
			k.Srcalpha = r.u32()
			k.Destalpha = r.u32()
			k.Mtpreset = r.u32()
			anims = append(anims, k)
		}
		if r.err != nil {
			return nil, r.err
		}
		out.Layers = append(out.Layers, Layer{Textures: textures, Animations: anims})
	}
	return out, nil
}
