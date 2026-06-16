package engine

import (
	"github.com/ragassets/zrenderer-gateway/internal/render/geom"
	"github.com/ragassets/zrenderer-gateway/internal/render/raster"
	"github.com/ragassets/zrenderer-gateway/internal/render/rotype"
	"github.com/ragassets/zrenderer-gateway/internal/render/sprite"
)

// sortFunc reorders sprite indices by z-index for a given output frame.
type sortFunc func(index []int, frame, maxframes int)

// drawPlayer composites the sprite stack into one image per animation frame.
// frame < 0 renders the whole action (animation); frame >= 0 renders that single
// frame. It is a faithful port of zrenderer's renderer.drawPlayer, including the
// per-frame head/accessory/garment frame-index logic that pins a fixed head
// direction while the body animates.
func drawPlayer(sprites []*sprite.Sprite, action uint, frame int, sortDg sortFunc, canvas Canvas) []raster.RawImage {
	drawSingleFrame := frame >= 0
	startframe := 0
	maxframes := 0
	if drawSingleFrame {
		startframe = frame
		maxframes = frame + 1
	}

	drawobjects := make([]raster.DrawObject, len(sprites))
	var totalBox geom.Box
	totalBox.ToInfinity()

	for si, s := range sprites {
		actionindex := int(action)
		frameindex := frame
		if s.Type == sprite.TypeShadow {
			actionindex = 0
			frameindex = 0
		}

		var dobj raster.DrawObject
		if !drawSingleFrame {
			dobj = s.DrawObjectsOfAction(actionindex)
			if n := len(dobj.Children); n > maxframes {
				maxframes = n
			}
		} else {
			pa := rotype.IntToPlayerAction(uint(actionindex))
			if s.Type == sprite.TypeAccessory && len(s.Act.Frames(actionindex)) > 3 &&
				(pa == rotype.ActStand || pa == rotype.ActSit) {
				n := len(s.Act.Frames(actionindex))
				dobj = s.DrawObjectsOfFrame(actionindex, (frameindex%3)*n/3)
			} else {
				dobj = s.DrawObjectsOfFrame(actionindex, frameindex)
			}
		}
		totalBox.UpdateBounds(dobj.BoundingBox)
		drawobjects[si] = dobj
	}

	totalWidth := totalBox.Width()
	totalHeight := totalBox.Height()
	if !canvas.IsZero() {
		totalWidth = canvas.Width
		totalHeight = canvas.Height
	}
	if totalWidth == 0 || totalHeight == 0 {
		return nil
	}

	offset := geom.Vec3{X: float32(totalBox.X1), Y: float32(totalBox.Y1)}
	if !canvas.IsZero() {
		offset = geom.Vec3{X: float32(-canvas.OriginX), Y: float32(-canvas.OriginY)}
	}

	out := make([]raster.RawImage, maxframes-startframe)
	sortIndex := make([]int, len(sprites))

	for i := startframe; i < maxframes; i++ {
		out[i-startframe] = raster.NewRawImage(totalWidth, totalHeight)
		sortDg(sortIndex, i, maxframes)

		for _, idx := range sortIndex {
			drawobject := drawobjects[idx]
			if !drawSingleFrame && len(drawobject.Children) == 0 {
				continue
			}

			s := sprites[idx]
			frameindex := i
			actionindex := int(action)
			frameoffset := 0
			pa := rotype.IntToPlayerAction(action)

			switch {
			case s.Type == sprite.TypeShadow:
				actionindex = 0
				frameindex = 0
			case (s.Type == sprite.TypePlayerHead || s.Type == sprite.TypeAccessory || s.Type == sprite.TypeGarment) &&
				(pa == rotype.ActStand || pa == rotype.ActSit):
				if !drawSingleFrame && maxframes >= 3 {
					frameCount := len(s.Act.Frames(int(action)))
					switch {
					case s.Type == sprite.TypeGarment:
						frameindex = i % maxframes
					case s.HeadDir != rotype.All:
						frameoffset = s.HeadDir.FrameDir() * frameCount / 3
					case s.Type == sprite.TypePlayerHead:
						frameindex = i / (maxframes / 3)
					case frameCount >= 3:
						// Other animated headgears.
						bigStep := maxframes / 3
						smallStep := frameCount / 3
						index := i / bigStep
						alignment := smallStep - ((index * bigStep) % smallStep)
						frameindex = (i+alignment)%smallStep + index*smallStep
					}
				} else if len(s.Act.Frames(int(action))) >= 3 {
					frameoffset = i*len(s.Act.Frames(int(action)))/3 - frameindex
				}
			}

			if !drawSingleFrame && frameindex >= len(drawobject.Children) {
				if len(drawobject.Children) == 3 && maxframes >= 3 {
					frameindex = i / (maxframes / 3) % len(drawobject.Children)
				} else if len(drawobject.Children) > 0 {
					frameindex = frameindex % len(drawobject.Children)
				} else {
					continue
				}
			}

			var frameobj raster.DrawObject
			if drawSingleFrame {
				frameobj = drawobject
			} else {
				frameobj = drawobject.Children[frameindex]
			}

			drawFrameOnImage(&out[i-startframe], s, actionindex, frameindex+frameoffset, frameobj, offset)
		}
	}

	return out
}

// drawFrameOnImage composites every layer of a single frame's draw object onto
// dest. The layer image is fetched at (action, frame) — which may differ from the
// frame the geometry was built from when a head direction is pinned. Mirrors
// renderer.drawFrameOnImage.
func drawFrameOnImage(dest *raster.RawImage, s *sprite.Sprite, action, frame int, frameobj raster.DrawObject, offset geom.Vec3) {
	layers := s.Act.Sprites(action, frame)
	for li, spriteobj := range frameobj.Children {
		if li >= len(layers) {
			continue
		}
		as := layers[li]
		img := s.Image(as.SprID, as.SprType)
		spriteOffset := geom.Vec3{
			X: float32(spriteobj.BoundingBox.X1) - offset.X,
			Y: float32(spriteobj.BoundingBox.Y1) - offset.Y,
		}
		raster.DrawSprite(dest, spriteobj, img, spriteOffset)
	}
}
