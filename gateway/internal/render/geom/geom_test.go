package geom

import (
	"math"
	"testing"
)

func approx(a, b float32) bool { return math.Abs(float64(a-b)) < 1e-3 }

func mat3Approx(a, b Mat3) bool {
	return approx(a.M11, b.M11) && approx(a.M12, b.M12) && approx(a.M13, b.M13) &&
		approx(a.M21, b.M21) && approx(a.M22, b.M22) && approx(a.M23, b.M23) &&
		approx(a.M31, b.M31) && approx(a.M32, b.M32) && approx(a.M33, b.M33)
}

// Ported from zrenderer's matrix.d unittest.
func TestMat3Mul(t *testing.T) {
	a := Mat3{1, 2, 3, 4, 5, 6, 7, 8, 9}
	b := Mat3{9, 8, 7, 6, 5, 4, 3, 2, 1}
	want := Mat3{30, 24, 18, 84, 69, 54, 138, 114, 90}
	if got := a.Mul(b); !mat3Approx(got, want) {
		t.Errorf("a*b = %+v, want %+v", got, want)
	}
	want2 := Mat3{90, 114, 138, 54, 69, 84, 18, 24, 30}
	if got := b.Mul(a); !mat3Approx(got, want2) {
		t.Errorf("b*a = %+v, want %+v", got, want2)
	}
}

// Ported from vector.d unittest: matrix * vector.
func TestMat3MulVec(t *testing.T) {
	m := Mat3{1, 2, 3, 4, 5, 6, 7, 8, 9}
	got := m.MulVec(Vec3{1, 2, 3})
	want := Vec3{14, 32, 50}
	if !approx(got.X, want.X) || !approx(got.Y, want.Y) || !approx(got.Z, want.Z) {
		t.Errorf("m*v = %+v, want %+v", got, want)
	}
}

// Ported from operations.d unittest: inverse and inverse*matrix == identity.
func TestMat3Inverse(t *testing.T) {
	m := Mat3{1, 2, 3, 4, 5, 6, 7, 8, 10}
	want := Mat3{-2.0 / 3, -4.0 / 3, 1, -2.0 / 3, 11.0 / 3, -2, 1, -2, 1}
	inv := m.Inverse()
	if !mat3Approx(inv, want) {
		t.Errorf("inverse = %+v, want %+v", inv, want)
	}
	if id := inv.Mul(m); !mat3Approx(id, Identity()) {
		t.Errorf("inv*m = %+v, want identity", id)
	}
}

func TestMat3InverseSingular(t *testing.T) {
	// Determinant 0 -> guarded, must not panic / divide by zero.
	m := Mat3{1, 2, 3, 4, 5, 6, 7, 8, 9}
	_ = m.Inverse()
}

// Ported from transform.d unittest: t * t.inverse == identity and round-trip.
func TestTransformRoundTrip(t *testing.T) {
	tr := NewTransform()
	tr.Origin = Vec2{0.5, 0.5}
	tr.Size = Vec2{10, 10}
	tr.Translation = Vec2{5, 5}
	tr.Scaling = Vec2{2, 2}
	tr.Rotation = math.Pi / 2
	tr.Calculate()

	inv := tr.Inverse()
	if id := tr.M.Mul(inv); !mat3Approx(id, Identity()) {
		t.Errorf("t*t^-1 = %+v, want identity", id)
	}

	p := Vec3{10, 5, 1}
	p2 := tr.Apply(p)
	back := inv.MulVec(p2)
	if !approx(back.X, p.X) || !approx(back.Y, p.Y) {
		t.Errorf("round trip got %+v, want %+v", back, p)
	}
}

func TestTransformBoundingBoxIdentity(t *testing.T) {
	tr := NewTransform()
	tr.Size = Vec2{4, 6}
	tr.Calculate()
	b := tr.BoundingBox()
	if b.X1 != 0 || b.Y1 != 0 || b.X2 != 4 || b.Y2 != 6 {
		t.Errorf("bbox = %+v, want {0 0 4 6}", b)
	}
	if b.Width() != 4 || b.Height() != 6 {
		t.Errorf("w/h = %d/%d, want 4/6", b.Width(), b.Height())
	}
}

func TestBoxInfinityAndBounds(t *testing.T) {
	var b Box
	b.ToInfinity()
	if !b.IsInfinite() {
		t.Fatal("expected infinite")
	}
	if b.Width() != 0 || b.Height() != 0 {
		t.Errorf("infinite w/h = %d/%d, want 0/0", b.Width(), b.Height())
	}
	b.UpdateBoundsF(2.9, -1.2, 5.5, 3.8)
	// Truncation toward zero: x1=trunc(2.9)=2... but min(inf,min(2.9,5.5))=2.9->2
	if b.X1 != 2 || b.Y1 != -1 || b.X2 != 5 || b.Y2 != 3 {
		t.Errorf("bounds = %+v, want {2 -1 5 3}", b)
	}
	var c Box
	c.ToInfinity()
	c.UpdateBounds(b)
	if c != b {
		t.Errorf("UpdateBounds(box) = %+v, want %+v", c, b)
	}
}
