// Package sprite assembles a loaded ACT+SPR pair into transformed, positioned
// draw objects for the renderer. It mirrors zrenderer's sprite.d: per-frame and
// per-action draw-object construction, attach-point parenting, and head-direction
// frame slicing.
package sprite

import (
	"github.com/ragassets/zrenderer-gateway/internal/render/geom"
	"github.com/ragassets/zrenderer-gateway/internal/render/raster"
	"github.com/ragassets/zrenderer-gateway/internal/render/roformat"
	"github.com/ragassets/zrenderer-gateway/internal/render/rotype"
)

// Type classifies a sprite for z-ordering and head-direction handling.
type Type int

const (
	TypeStandard Type = iota
	TypeAccessory
	TypeCostume
	TypeGarment
	TypeHomunculus
	TypeMercenary
	TypeMonster
	TypeNPC
	TypePlayerBody
	TypePlayerHead
	TypeShadow
	TypeShield
	TypeWeapon
)

// Sprite is a loaded ACT+SPR with rendering metadata. Images are decoded lazily
// through Palette and cached per instance (one Sprite is built per render).
type Sprite struct {
	Act *roformat.Act
	Spr *roformat.Spr

	// Palette overrides the SPR's embedded palette when non-nil (body/head dye).
	Palette roformat.Palette

	Type      Type
	TypeOrder int                  // ordering within a type (accessory 0..2, etc.)
	ZIndex    int                  // assigned by the engine before sorting
	HeadDir   rotype.HeadDirection // head facing (head/accessory only)
	Parent    *Sprite              // attach-point parent (body), nil if unparented
	// Behind draws this accessory behind the body/head (effect-type headgears such
	// as auras/halos). RO decides this in client code with no GRF signal, so the
	// caller marks these ids explicitly.
	Behind bool

	// OffsetAdjust is an extra parent-attach offset (doram headgear positioning).
	OffsetAdjust geom.Vec3
	// ScaleOverride, when non-nil, replaces each layer's scale (shadow scaling).
	ScaleOverride *float32

	imgCache map[imgKey]raster.RawImage
}

type imgKey struct {
	id, typ int
}

// New builds a Sprite from a parsed ACT+SPR.
func New(act *roformat.Act, spr *roformat.Spr, typ Type) *Sprite {
	return &Sprite{Act: act, Spr: spr, Type: typ, HeadDir: rotype.Straight, imgCache: map[imgKey]raster.RawImage{}}
}

// Image decodes (and caches) a SPR image using this sprite's palette override.
func (s *Sprite) Image(id, sprType int) raster.RawImage {
	k := imgKey{id, sprType}
	if img, ok := s.imgCache[k]; ok {
		return img
	}
	img := s.Spr.DecodeImage(id, sprType, s.Palette)
	s.imgCache[k] = img
	return img
}

// transformOfSprite builds the affine transform for one ACT sprite layer. When
// the layer's tint is fully transparent the transform is left as identity (the
// layer contributes nothing), matching zrenderer.
func (s *Sprite) transformOfSprite(as roformat.ActSprite, width, height int, parentOffset geom.Vec3) geom.Transform {
	t := geom.NewTransform()
	if as.Tint.A != 0 {
		mirror := float32(1)
		mirrorAdjust := float32(0)
		if as.Mirrored() {
			mirror = -1
			mirrorAdjust = 0.5 // dirty hack from zrenderer to fix rounding on mirror
		}
		xScale, yScale := as.XScale, as.YScale
		if s.ScaleOverride != nil {
			xScale, yScale = *s.ScaleOverride, *s.ScaleOverride
		}
		t.Origin = geom.Vec2{X: 0.5, Y: 0.5}
		t.Size = geom.Vec2{X: float32(width) - mirrorAdjust, Y: float32(height)}
		t.Scaling = geom.Vec2{X: xScale * mirror, Y: yScale}
		t.Translation = geom.Vec2{X: float32(as.X) + parentOffset.X, Y: float32(as.Y) + parentOffset.Y}
		t.Rotation = float32(as.Rotation) * geom.Pi180
	}
	t.Calculate()
	return t
}

// drawObjectOfSprite builds the draw object for one layer. ok is false when the
// layer's image is missing, in which case the caller skips it entirely.
func (s *Sprite) drawObjectOfSprite(as roformat.ActSprite, parentOffset geom.Vec3) (raster.DrawObject, bool) {
	img := s.Image(as.SprID, as.SprType)
	if img.Empty() {
		return raster.DrawObject{}, false
	}
	t := s.transformOfSprite(as, img.Width, img.Height, parentOffset)
	return raster.DrawObject{
		Tint:        as.Tint,
		BoundingBox: t.BoundingBox(),
		Transform:   t,
	}, true
}

// DrawObjectsOfFrame builds a frame draw object: one child per ACT sprite layer
// (zero/skipped for missing images), positioned relative to the parent's attach
// point when this sprite is parented. Mirrors sprite.d drawObjectsOfFrame.
func (s *Sprite) DrawObjectsOfFrame(action, frame int) raster.DrawObject {
	layers := s.Act.Sprites(action, frame)
	out := raster.DrawObject{Children: make([]raster.DrawObject, len(layers))}
	out.BoundingBox.ToInfinity()

	parentOffset := geom.Vec3{}
	if s.Parent != nil {
		parentFrame := frame
		pa := rotype.IntToPlayerAction(uint(action))
		if s.Type == TypeAccessory && (pa == rotype.ActStand || pa == rotype.ActSit) {
			if s.HeadDir != rotype.All {
				parentFrame = s.HeadDir.FrameDir()
			} else if n := len(s.Act.Frames(action)); n >= 3 {
				parentFrame = frame / (n / 3)
			}
		}
		if len(s.Parent.Act.AttachPoints(action, parentFrame)) > 0 {
			pap := s.Parent.Act.AttachPoint(action, parentFrame, 0)
			parentOffset = geom.Vec3{X: float32(pap.X), Y: float32(pap.Y)}
		}
		if len(s.Act.AttachPoints(action, frame)) > 0 {
			ap := s.Act.AttachPoint(action, frame, 0)
			parentOffset = geom.Vec3{X: parentOffset.X - float32(ap.X), Y: parentOffset.Y - float32(ap.Y)}
		}
		// Doram headgear positioning adjustment.
		parentOffset.X += s.OffsetAdjust.X
		parentOffset.Y += s.OffsetAdjust.Y
	}

	for i, as := range layers {
		obj, ok := s.drawObjectOfSprite(as, parentOffset)
		if !ok {
			continue
		}
		out.Children[i] = obj
		out.BoundingBox.UpdateBounds(obj.BoundingBox)
	}

	if out.BoundingBox.IsInfinite() {
		return raster.DrawObject{}
	}
	return out
}

// DrawObjectsOfAction builds an action draw object: one child per frame. For a
// head/accessory with a fixed head direction in stand/sit, the frame range is
// sliced to that direction's third of the frames. Mirrors drawObjectsOfAction.
func (s *Sprite) DrawObjectsOfAction(action int) raster.DrawObject {
	frameFrom := 0
	frameTo := len(s.Act.Frames(action))

	if (s.Type == TypePlayerHead || s.Type == TypeAccessory) && s.HeadDir != rotype.All && frameTo >= 3 {
		pa := rotype.IntToPlayerAction(uint(action))
		if pa == rotype.ActStand || pa == rotype.ActSit {
			frameCount := frameTo / 3
			frameFrom = s.HeadDir.FrameDir() * frameCount
			frameTo = frameFrom + frameCount
		}
	}

	out := raster.DrawObject{Children: make([]raster.DrawObject, frameTo-frameFrom)}
	out.BoundingBox.ToInfinity()
	for i := frameFrom; i < frameTo; i++ {
		child := s.DrawObjectsOfFrame(action, i)
		out.Children[i-frameFrom] = child
		out.BoundingBox.UpdateBounds(child.BoundingBox)
	}
	if out.BoundingBox.IsInfinite() {
		return raster.DrawObject{}
	}
	return out
}
