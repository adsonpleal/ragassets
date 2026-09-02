package engine

// Canvas is an explicit output frame with an origin point at which the sprite's
// (0,0) is placed. The zero Canvas means "auto-size to the sprite bounds".
type Canvas struct {
	Width   int
	Height  int
	OriginX int
	OriginY int
}

// IsZero reports whether no explicit canvas was requested.
func (c Canvas) IsZero() bool { return c == Canvas{} }

// Canvas dimensions come straight off the query string and flow into
// raster.NewRawImage, which allocates Width*Height 4-byte pixels with no ceiling
// of its own. Without these bounds `?canvas=50000x50000+0+0` asks for a 10 GB
// buffer and takes the process down — unauthenticated, from one request.
//
// maxCanvasSide is generous next to real sprites (a full-body render is a few
// hundred pixels a side); maxCanvasPixels is the one that actually matters,
// capping a frame buffer at 16 MB so a long thin canvas cannot slip past the
// per-side limit.
const (
	maxCanvasSide   = 4096
	maxCanvasPixels = 4 << 20 // 2048×2048, i.e. 16 MB at 4 bytes per pixel
)

// ParseCanvas parses a "<w>x<h>±<x>±<y>" canvas string. An empty string yields
// the zero Canvas (auto-size). ok is false for malformed non-empty input, and
// for dimensions beyond the bounds above.
//
// Hand-written rather than a regexp: the grammar is four integer fields and two
// delimiters, and dropping the dependency keeps `regexp` (~200 KB of binary, and
// its init-time compilation) out of the render path entirely.
func ParseCanvas(s string) (Canvas, bool) {
	if s == "" {
		return Canvas{}, true
	}

	// <w>
	w, i, ok := scanUint(s, 0)
	if !ok {
		return Canvas{}, false
	}
	// 'x'
	if i >= len(s) || s[i] != 'x' {
		return Canvas{}, false
	}
	i++
	// <h>
	h, i, ok := scanUint(s, i)
	if !ok {
		return Canvas{}, false
	}
	// ±<x>
	ox, i, ok := scanSigned(s, i)
	if !ok {
		return Canvas{}, false
	}
	// ±<y>
	oy, i, ok := scanSigned(s, i)
	if !ok {
		return Canvas{}, false
	}
	// Nothing may follow.
	if i != len(s) {
		return Canvas{}, false
	}

	if w > maxCanvasSide || h > maxCanvasSide || w*h > maxCanvasPixels {
		return Canvas{}, false
	}
	return Canvas{Width: w, Height: h, OriginX: ox, OriginY: oy}, true
}

// scanUint reads one or more digits at s[i:], returning the value and the index
// just past them. It fails on no digits, or on a run long enough to overflow —
// the old regexp accepted `[0-9]+` unbounded and let atoi wrap silently.
func scanUint(s string, i int) (val, next int, ok bool) {
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		val = val*10 + int(s[i]-'0')
		i++
		if i-start > 9 { // > 999,999,999: far past any legal canvas
			return 0, 0, false
		}
	}
	if i == start {
		return 0, 0, false
	}
	return val, i, true
}

// scanSigned reads a mandatory '+' or '-' followed by digits, matching the
// original `([+-][0-9]+)` groups.
func scanSigned(s string, i int) (val, next int, ok bool) {
	if i >= len(s) || (s[i] != '+' && s[i] != '-') {
		return 0, 0, false
	}
	neg := s[i] == '-'
	n, next, ok := scanUint(s, i+1)
	if !ok {
		return 0, 0, false
	}
	if neg {
		n = -n
	}
	return n, next, true
}
