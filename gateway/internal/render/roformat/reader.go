// Package roformat parses the Ragnarok Online binary asset formats used by the
// renderer: SPR (sprite bitmaps + palette), ACT (animation/layout), PAL
// (palette) and IMF (layer priority). It mirrors zrenderer's resource.* modules.
//
// All multi-byte integers in these formats are little-endian, except the ver≥2.0
// RGBA pixel words in SPR which zrenderer reads big-endian (see spr.go).
package roformat

import (
	"encoding/binary"
	"fmt"
	"math"
)

// reader is a forward cursor over a byte slice, providing the little-endian
// reads that zrenderer expresses as buffer.peekLE!T(&offset). Out-of-range reads
// set err and return zero; callers check err once after a run of reads.
type reader struct {
	buf []byte
	off int
	err error
}

func newReader(buf []byte) *reader { return &reader{buf: buf} }

func (r *reader) remaining() int { return len(r.buf) - r.off }

func (r *reader) need(n int) bool {
	if r.err != nil {
		return false
	}
	if r.off+n > len(r.buf) {
		r.err = fmt.Errorf("roformat: unexpected EOF at offset %d (need %d, have %d)", r.off, n, len(r.buf)-r.off)
		return false
	}
	return true
}

func (r *reader) u8() uint8 {
	if !r.need(1) {
		return 0
	}
	v := r.buf[r.off]
	r.off++
	return v
}

func (r *reader) u16() uint16 {
	if !r.need(2) {
		return 0
	}
	v := binary.LittleEndian.Uint16(r.buf[r.off:])
	r.off += 2
	return v
}

func (r *reader) u32() uint32 {
	if !r.need(4) {
		return 0
	}
	v := binary.LittleEndian.Uint32(r.buf[r.off:])
	r.off += 4
	return v
}

func (r *reader) i32() int32 { return int32(r.u32()) }

func (r *reader) f32() float32 {
	return math.Float32frombits(r.u32())
}

// skip advances the cursor by n bytes.
func (r *reader) skip(n int) {
	if !r.need(n) {
		return
	}
	r.off += n
}
