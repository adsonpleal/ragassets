package roformat

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// leBuf is a little-endian byte builder used to hand-craft format fixtures.
type leBuf struct{ b []byte }

func (w *leBuf) bytes(p ...byte) *leBuf { w.b = append(w.b, p...); return w }
func (w *leBuf) str(s string) *leBuf    { w.b = append(w.b, s...); return w }

func (w *leBuf) u8(v uint8) *leBuf { w.b = append(w.b, v); return w }

func (w *leBuf) u16(v uint16) *leBuf {
	w.b = binary.LittleEndian.AppendUint16(w.b, v)
	return w
}

func (w *leBuf) u32(v uint32) *leBuf {
	w.b = binary.LittleEndian.AppendUint32(w.b, v)
	return w
}

func (w *leBuf) i32(v int32) *leBuf { return w.u32(uint32(v)) }

func (w *leBuf) f32(v float32) *leBuf {
	w.b = binary.LittleEndian.AppendUint32(w.b, math.Float32bits(v))
	return w
}

func (w *leBuf) zeros(n int) *leBuf { w.b = append(w.b, make([]byte, n)...); return w }

// palette1024 builds a 1024-byte palette block from a sparse map of index→RGBA.
func palette1024(entries map[int][4]byte) []byte {
	b := make([]byte, 1024)
	for idx, rgba := range entries {
		copy(b[idx*4:], rgba[:])
	}
	return b
}

// repoFile resolves a path relative to the repository root (4 levels up from this
// package: roformat → render → internal → gateway → repo root) and skips the test
// when the file is absent (resources/ is gitignored and not always present).
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	p := filepath.Join("..", "..", "..", "..", rel)
	if _, err := os.Stat(p); err != nil {
		t.Skipf("asset not present (%s): %v", rel, err)
	}
	return p
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}
