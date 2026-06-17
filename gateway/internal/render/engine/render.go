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
// frame. A single-frame request returns exactly the Nth frame of the animation
// (the same compositing as the APNG), so &frame=N is the still the player would
// see if the animation were paused on frame N — head pinned to its direction,
// body retained, animated headgears/garments advanced. It is a faithful port of
// zrenderer's renderer.drawPlayer, including the per-frame head/accessory/garment
// frame-index logic (see resolveFrame) that pins a fixed head direction while the
// body animates.
func drawPlayer(sprites []*sprite.Sprite, action uint, frame int, sortDg sortFunc, canvas Canvas) []raster.RawImage {
	drawSingleFrame := frame >= 0

	// Build each sprite's whole-action draw object (one child per frame, with
	// head-direction slicing already applied). maxframes is the resolved
	// animation length the longest layer (often an animated costume) defines;
	// actionBox is the union over every frame — the stable canvas an animation's
	// frames share.
	drawobjects := make([]raster.DrawObject, len(sprites))
	maxframes := 0
	var actionBox geom.Box
	actionBox.ToInfinity()
	for si, s := range sprites {
		actionindex := int(action)
		if s.Type == sprite.TypeShadow {
			actionindex = 0
		}
		dobj := s.DrawObjectsOfAction(actionindex)
		if n := len(dobj.Children); n > maxframes {
			maxframes = n
		}
		actionBox.UpdateBounds(dobj.BoundingBox)
		drawobjects[si] = dobj
	}
	if maxframes == 0 {
		return nil
	}

	// Output range: the whole action, or just frame N (wrapped) for a still.
	startframe, endframe := 0, maxframes
	if drawSingleFrame {
		startframe = frame % maxframes
		endframe = startframe + 1
	}

	// Bounding box: the whole-action box for an animation (every frame aligns on
	// one canvas); the chosen frame's own box for a still (kept tight, matching
	// the per-frame crop the old still path produced).
	totalBox := actionBox
	if drawSingleFrame {
		totalBox.ToInfinity()
		for si, s := range sprites {
			if obj, _, _, ok := resolveFrame(s, action, startframe, maxframes, drawobjects[si]); ok {
				totalBox.UpdateBounds(obj.BoundingBox)
			}
		}
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

	out := make([]raster.RawImage, endframe-startframe)
	sortIndex := make([]int, len(sprites))

	for i := startframe; i < endframe; i++ {
		out[i-startframe] = raster.NewRawImage(totalWidth, totalHeight)
		sortDg(sortIndex, i, maxframes)

		for _, idx := range sortIndex {
			s := sprites[idx]
			frameobj, imageFrame, actionindex, ok := resolveFrame(s, action, i, maxframes, drawobjects[idx])
			if !ok {
				continue
			}
			drawFrameOnImage(&out[i-startframe], s, actionindex, imageFrame, frameobj, offset)
		}
	}

	return out
}

// resolveFrame selects, for output frame i of an action animation, the geometry
// child a sprite contributes and the act frame its image is fetched from. It is
// the per-sprite frame-index logic shared by every output frame (animation or a
// single still), so a paused still on frame i composites identically to that
// frame of the APNG: the head is pinned to its direction (frameoffset), short
// layers like the body repeat across a longer costume timeline instead of running
// off the end, and animated headgears/garments advance. ok is false when the
// sprite draws nothing this frame. Mirrors zrenderer's renderer.drawPlayer.
func resolveFrame(s *sprite.Sprite, action uint, i, maxframes int, dobj raster.DrawObject) (frameobj raster.DrawObject, imageFrame, actionindex int, ok bool) {
	if len(dobj.Children) == 0 {
		return raster.DrawObject{}, 0, int(action), false
	}

	actionindex = int(action)
	frameindex := i
	frameoffset := 0
	pa := rotype.IntToPlayerAction(action)

	switch {
	case s.Type == sprite.TypeShadow:
		actionindex = 0
		frameindex = 0
	case (s.Type == sprite.TypePlayerHead || s.Type == sprite.TypeAccessory || s.Type == sprite.TypeGarment) &&
		(pa == rotype.ActStand || pa == rotype.ActSit):
		if maxframes >= 3 {
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

	if frameindex >= len(dobj.Children) {
		if len(dobj.Children) == 3 && maxframes >= 3 {
			frameindex = i / (maxframes / 3) % len(dobj.Children)
		} else {
			frameindex = frameindex % len(dobj.Children)
		}
	}

	return dobj.Children[frameindex], frameindex + frameoffset, actionindex, true
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
