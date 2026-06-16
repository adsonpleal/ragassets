package geom

import "math"

const (
	intMax = math.MaxInt32
	intMin = math.MinInt32
)

// Box is an integer axis-aligned bounding box (zrenderer's linearalgebra.Box).
// The game engine works in integer pixel space, so float bounds are truncated
// toward zero, matching the D reference.
type Box struct {
	X1, Y1, X2, Y2 int
}

// ToInfinity resets the box to the "empty/inverted" state used as the identity
// for UpdateBounds accumulation.
func (b *Box) ToInfinity() {
	b.X1, b.Y1 = intMax, intMax
	b.X2, b.Y2 = intMin, intMin
}

// IsInfinite reports whether the box is still in its reset (no-bounds) state.
func (b Box) IsInfinite() bool {
	return b.X1 == intMax || b.Y1 == intMax || b.X2 == intMin || b.Y2 == intMin
}

// Width is |X2-X1|, or 0 for an unbounded box.
func (b Box) Width() int {
	if b.X1 == intMax || b.X2 == intMax || b.X1 == intMin || b.X2 == intMin {
		return 0
	}
	return abs(b.X2 - b.X1)
}

// Height is |Y2-Y1|, or 0 for an unbounded box.
func (b Box) Height() int {
	if b.Y1 == intMax || b.Y2 == intMax || b.Y1 == intMin || b.Y2 == intMin {
		return 0
	}
	return abs(b.Y2 - b.Y1)
}

// UpdateBoundsF expands the box to include the float rectangle (x1,y1)-(x2,y2),
// truncating toward zero (zrenderer's float overload of updateBounds).
func (b *Box) UpdateBoundsF(x1, y1, x2, y2 float32) {
	b.X1 = int(fmin(float32(b.X1), fmin(x1, x2)))
	b.Y1 = int(fmin(float32(b.Y1), fmin(y1, y2)))
	b.X2 = int(fmax(float32(b.X2), fmax(x1, x2)))
	b.Y2 = int(fmax(float32(b.Y2), fmax(y1, y2)))
}

// UpdateBoundsPoints expands the box to include two points.
func (b *Box) UpdateBoundsPoints(a, c Vec2) {
	b.UpdateBoundsF(a.X, a.Y, c.X, c.Y)
}

// UpdateBounds expands the box to include another box.
func (b *Box) UpdateBounds(o Box) {
	b.X1 = minI(b.X1, minI(o.X1, o.X2))
	b.Y1 = minI(b.Y1, minI(o.Y1, o.Y2))
	b.X2 = maxI(b.X2, maxI(o.X1, o.X2))
	b.Y2 = maxI(b.Y2, maxI(o.Y1, o.Y2))
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func minI(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxI(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func fmin(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}

func fmax(a, b float32) float32 {
	if a > b {
		return a
	}
	return b
}
