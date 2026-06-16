package geom

// Transform is zrenderer's TransformMatrix: a parameterized affine transform
// (size, origin, translation, scaling, rotation) that bakes down to a Mat3 via
// Calculate. The composition order is T·R·S·translate(-size*origin, rounded).
type Transform struct {
	Size        Vec2
	Origin      Vec2
	Translation Vec2
	Scaling     Vec2
	Rotation    float32 // radians
	M           Mat3
}

// NewTransform returns an identity transform (scaling 1,1).
func NewTransform() Transform {
	return Transform{Scaling: Vec2{1, 1}, M: Identity()}
}

// Calculate composes the parameters into M and returns it.
func (t *Transform) Calculate() Mat3 {
	m := Identity()
	m = m.Mul(Translation(t.Translation.X, t.Translation.Y))
	m = m.Mul(RotationMat(t.Rotation))
	m = m.Mul(ScaleMat(t.Scaling.X, t.Scaling.Y))
	ox := roundF(-t.Size.X * t.Origin.X)
	oy := roundF(-t.Size.Y * t.Origin.Y)
	m = m.Mul(Translation(ox, oy))
	t.M = m
	return m
}

// Apply transforms a point through the baked matrix.
func (t Transform) Apply(v Vec3) Vec3 { return t.M.MulVec(v) }

// Inverse returns the inverse of the baked matrix.
func (t Transform) Inverse() Mat3 { return t.M.Inverse() }

// BoundingBox returns the integer bounding box of the transformed quad
// [0,0]–[Size]. It mirrors zrenderer's boundingBoxOfTransform.
func (t Transform) BoundingBox() Box {
	tl := t.M.MulVec(Vec3{0, 0, 1})
	tr := t.M.MulVec(Vec3{t.Size.X, 0, 1})
	bl := t.M.MulVec(Vec3{0, t.Size.Y, 1})
	br := t.M.MulVec(Vec3{t.Size.X, t.Size.Y, 1})

	var b Box
	b.ToInfinity()
	b.UpdateBoundsPoints(tl.XY(), tr.XY())
	b.UpdateBoundsPoints(bl.XY(), br.XY())
	return b
}
