// Package geom provides the 2D affine math the renderer needs: 3x3 matrices,
// 2/3-vectors, an SFML-style TransformMatrix, and an integer bounding Box. It
// mirrors zrenderer's linearalgebra.* modules and deliberately uses float32 so
// rounding matches the D reference at sub-pixel boundaries.
package geom

import "math"

// Pi180 converts degrees to radians (zrenderer's PI_180).
const Pi180 = math.Pi / 180.0

// Vec2 is a 2D float vector.
type Vec2 struct{ X, Y float32 }

// Vec3 is a 3D float vector (used in homogeneous 2D coordinates with Z=1).
type Vec3 struct{ X, Y, Z float32 }

// XY drops the Z component.
func (v Vec3) XY() Vec2 { return Vec2{v.X, v.Y} }

// Mat3 is a row-major 3x3 matrix.
type Mat3 struct {
	M11, M12, M13 float32
	M21, M22, M23 float32
	M31, M32, M33 float32
}

// Identity returns the 3x3 identity matrix.
func Identity() Mat3 {
	return Mat3{
		1, 0, 0,
		0, 1, 0,
		0, 0, 1,
	}
}

// Translation returns a translation matrix.
func Translation(x, y float32) Mat3 {
	return Mat3{
		1, 0, x,
		0, 1, y,
		0, 0, 1,
	}
}

// ScaleMat returns a scaling matrix.
func ScaleMat(x, y float32) Mat3 {
	return Mat3{
		x, 0, 0,
		0, y, 0,
		0, 0, 1,
	}
}

// RotationMat returns a rotation matrix for the given angle in radians.
func RotationMat(rad float32) Mat3 {
	s := float32(math.Sin(float64(rad)))
	c := float32(math.Cos(float64(rad)))
	return Mat3{
		c, -s, 0,
		s, c, 0,
		0, 0, 1,
	}
}

// Mul returns a*b (standard matrix multiplication).
func (a Mat3) Mul(b Mat3) Mat3 {
	return Mat3{
		a.M11*b.M11 + a.M12*b.M21 + a.M13*b.M31,
		a.M11*b.M12 + a.M12*b.M22 + a.M13*b.M32,
		a.M11*b.M13 + a.M12*b.M23 + a.M13*b.M33,
		a.M21*b.M11 + a.M22*b.M21 + a.M23*b.M31,
		a.M21*b.M12 + a.M22*b.M22 + a.M23*b.M32,
		a.M21*b.M13 + a.M22*b.M23 + a.M23*b.M33,
		a.M31*b.M11 + a.M32*b.M21 + a.M33*b.M31,
		a.M31*b.M12 + a.M32*b.M22 + a.M33*b.M32,
		a.M31*b.M13 + a.M32*b.M23 + a.M33*b.M33,
	}
}

// MulVec returns m*v (matrix·vector).
func (m Mat3) MulVec(v Vec3) Vec3 {
	return Vec3{
		m.M11*v.X + m.M12*v.Y + m.M13*v.Z,
		m.M21*v.X + m.M22*v.Y + m.M23*v.Z,
		m.M31*v.X + m.M32*v.Y + m.M33*v.Z,
	}
}

// Det returns the determinant.
func (m Mat3) Det() float32 {
	return m.M11*m.M22*m.M33 +
		m.M12*m.M23*m.M31 +
		m.M13*m.M21*m.M32 -
		m.M31*m.M22*m.M13 -
		m.M32*m.M23*m.M11 -
		m.M33*m.M21*m.M12
}

// Inverse returns the matrix inverse. A zero determinant is clamped to the
// float32 epsilon (matching zrenderer, whose isClose(det,0) guard reduces to an
// exact zero test), so this never divides by zero.
func (m Mat3) Inverse() Mat3 {
	det := m.Det()
	if det == 0 {
		det = floatEpsilon
	}
	inv := 1 / det
	return Mat3{
		inv * (m.M22*m.M33 - m.M23*m.M32),
		inv * (m.M13*m.M32 - m.M12*m.M33),
		inv * (m.M12*m.M23 - m.M13*m.M22),
		inv * (m.M23*m.M31 - m.M21*m.M33),
		inv * (m.M11*m.M33 - m.M13*m.M31),
		inv * (m.M13*m.M21 - m.M11*m.M23),
		inv * (m.M21*m.M32 - m.M22*m.M31),
		inv * (m.M12*m.M31 - m.M11*m.M32),
		inv * (m.M11*m.M22 - m.M12*m.M21),
	}
}

// floatEpsilon mirrors D's float.epsilon (smallest representable float32 step).
const floatEpsilon = 1.19209290e-07

// roundF rounds half away from zero (matching D's std.math.round).
func roundF(v float32) float32 {
	return float32(math.Round(float64(v)))
}

// Round applies round-half-away-from-zero to each component.
func (v Vec3) Round() Vec3 {
	return Vec3{roundF(v.X), roundF(v.Y), roundF(v.Z)}
}
