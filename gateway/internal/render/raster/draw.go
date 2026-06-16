package raster

import "github.com/ragassets/zrenderer-gateway/internal/render/geom"

// DrawObject is a positioned, transformed sprite layer ready to be rasterized.
// It mirrors zrenderer's draw.DrawObject. A node with Children is a frame whose
// children are its sprite layers; a leaf carries a concrete Transform/BoundingBox.
type DrawObject struct {
	Tint        Color
	Offset      geom.Vec3
	BoundingBox geom.Box
	Transform   geom.Transform
	Children    []DrawObject
}

// Zero reports whether the draw object is empty (no transform/bounds), the
// equivalent of DrawObject.init in zrenderer.
func (o DrawObject) Zero() bool {
	return o.BoundingBox == geom.Box{} && len(o.Children) == 0 &&
		o.Transform.M == geom.Mat3{} && o.Tint == Color{}
}

// DrawSprite composites one transformed source image onto dest. For every pixel
// of the transformed bounding box it maps back through the inverse transform
// (nearest-neighbour) into the source, then tints and alpha-blends. Mirrors
// zrenderer's drawSpriteOnImage.
func DrawSprite(dest *RawImage, obj DrawObject, source RawImage, offset geom.Vec3) {
	if obj.Tint.A == 0x00 || source.Empty() {
		return
	}

	w := obj.BoundingBox.Width()
	h := obj.BoundingBox.Height()
	inv := obj.Transform.Inverse()

	offX := int(offset.X)
	offY := int(offset.Y)
	bx1 := float32(obj.BoundingBox.X1)
	by1 := float32(obj.BoundingBox.Y1)

	for i := 0; i < w*h; i++ {
		tx := i % w
		ty := i / w

		destX := tx + offX
		destY := ty + offY
		if destX < 0 || destX >= dest.Width || destY < 0 || destY >= dest.Height {
			continue
		}

		srcPt := inv.MulVec(geom.Vec3{X: float32(tx) + bx1, Y: float32(ty) + by1, Z: 1}).Round()
		if srcPt.X < 0 || srcPt.Y < 0 || int(srcPt.X) >= source.Width || int(srcPt.Y) >= source.Height {
			continue
		}

		srcPixel := source.Pixels[int(srcPt.X)+int(srcPt.Y)*source.Width]
		if srcPixel.A == 0x00 {
			continue
		}

		outIdx := destX + destY*dest.Width
		dest.Pixels[outIdx] = AlphaBlend(dest.Pixels[outIdx], TintPixel(srcPixel, obj.Tint))
	}
}

// ApplyBabyScaling shrinks each frame by scaleFactor using nearest-neighbour
// sampling (zrenderer's applyBabyScaling). Returns the input unchanged when the
// factor is ~1 or there are no frames.
func ApplyBabyScaling(images []RawImage, scaleFactor float32) []RawImage {
	if len(images) == 0 || isClose1(scaleFactor) {
		return images
	}
	newW := int(float32(images[0].Width) * scaleFactor)
	newH := int(float32(images[0].Height) * scaleFactor)
	if newW <= 0 || newH <= 0 {
		return images
	}
	var inverseScale float32
	if scaleFactor != 0 {
		inverseScale = 1 / scaleFactor
	}

	for i := range images {
		src := images[i]
		out := NewRawImage(newW, newH)
		for p := range out.Pixels {
			dstX := p % newW
			dstY := p / newW
			srcX := int(float32(dstX) * inverseScale)
			srcY := int(float32(dstY) * inverseScale)
			if srcX < 0 || srcY < 0 || srcX >= src.Width || srcY >= src.Height {
				continue
			}
			out.Pixels[p] = src.Pixels[srcX+srcY*src.Width]
		}
		images[i] = out
	}
	return images
}

func isClose1(v float32) bool {
	d := v - 1
	if d < 0 {
		d = -d
	}
	return d < 1e-6
}
