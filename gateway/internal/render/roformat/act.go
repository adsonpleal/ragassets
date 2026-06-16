package roformat

import (
	"errors"
	"fmt"

	"github.com/ragassets/zrenderer-gateway/internal/render/raster"
)

// ActSprite is one layer of an animation frame: which SPR image to draw and how
// to place/scale/rotate/tint it. Fields mirror zrenderer's resource.act.ActSprite.
type ActSprite struct {
	X, Y     int
	SprID    int
	Flags    uint32 // bit 0 = horizontally mirrored
	Tint     raster.Color
	XScale   float32
	YScale   float32
	Rotation int
	SprType  int // 0 = palette-indexed image, 1 = rgba image
	Width    int
	Height   int
}

// Mirrored reports whether the sprite is drawn horizontally flipped.
func (s ActSprite) Mirrored() bool { return s.Flags&1 != 0 }

// ActAttachPoint is an anchor used to position child sprites (head/headgear) on
// their parent (body). Only attach point 0 is used by the renderer.
type ActAttachPoint struct {
	X, Y int
	Attr int
}

// ActFrame is one frame of an action: a stack of sprite layers plus attach points.
type ActFrame struct {
	EventID      int
	Sprites      []ActSprite
	AttachPoints []ActAttachPoint
}

// ActAction is a single animation (e.g. stand facing south) as a list of frames.
type ActAction struct {
	Interval float32
	Frames   []ActFrame
}

const minActSize = 18 + 2 + 10

// Act is a parsed .act file.
type Act struct {
	Ver     uint16
	Actions []ActAction
}

// ParseAct parses a .act file buffer.
func ParseAct(buf []byte) (*Act, error) {
	if len(buf) < minActSize {
		return nil, fmt.Errorf("act: too small (%d bytes, need >= %d)", len(buf), minActSize)
	}
	if buf[0] != 'A' || buf[1] != 'C' {
		return nil, errors.New("act: bad signature (expected 'AC')")
	}

	a := &Act{}
	r := newReader(buf)
	r.skip(2) // signature
	a.Ver = r.u16()
	numActions := int(r.u16())
	r.skip(10) // reserved

	a.Actions = make([]ActAction, numActions)
	for ai := range a.Actions {
		numFrames := int(r.u32())
		if numFrames > 0 {
			a.Actions[ai].Frames = make([]ActFrame, numFrames)
			for fi := range a.Actions[ai].Frames {
				a.readFrame(r, &a.Actions[ai].Frames[fi])
			}
		}
		// Default interval (overwritten below for ver>=0x202).
		a.Actions[ai].Interval = 4
	}

	if a.Ver >= 0x201 {
		numEvents := int(r.u32())
		r.skip(numEvents * 40) // event name strings (unused by the renderer)

		if a.Ver >= 0x202 {
			for ai := range a.Actions {
				a.Actions[ai].Interval = r.f32()
			}
		}
	}

	if r.err != nil {
		return nil, r.err
	}
	return a, nil
}

func (a *Act) readFrame(r *reader, frame *ActFrame) {
	r.skip(8 * 4) // attackRange + fitRange (8 ints), unused
	numSprites := int(r.u32())
	if numSprites > 0 {
		frame.Sprites = make([]ActSprite, numSprites)
		for si := range frame.Sprites {
			a.readSprite(r, &frame.Sprites[si])
		}
	}

	if a.Ver >= 0x200 {
		frame.EventID = int(r.i32())
		if a.Ver >= 0x203 {
			numAttach := int(r.u32())
			if numAttach > 0 {
				frame.AttachPoints = make([]ActAttachPoint, numAttach)
				for pi := range frame.AttachPoints {
					r.skip(4) // 4 reserved bytes
					frame.AttachPoints[pi] = ActAttachPoint{
						X:    int(r.i32()),
						Y:    int(r.i32()),
						Attr: int(r.i32()),
					}
				}
			}
		}
	}
}

func (a *Act) readSprite(r *reader, s *ActSprite) {
	s.X = int(r.i32())
	s.Y = int(r.i32())
	s.SprID = int(r.i32())
	s.Flags = r.u32()
	s.Tint = colorFromAABBGGRR(r.u32())
	s.XScale = r.f32()
	if a.Ver >= 0x204 {
		s.YScale = r.f32()
	} else {
		s.YScale = s.XScale
	}
	s.Rotation = int(r.i32())
	s.SprType = int(r.i32())
	if a.Ver >= 0x205 {
		s.Width = int(r.i32())
		s.Height = int(r.i32())
	}
}

// NumberOfFrames returns the frame count for an action (0 if out of range).
func (a *Act) NumberOfFrames(action int) int {
	if action < 0 || action >= len(a.Actions) {
		return 0
	}
	return len(a.Actions[action].Frames)
}

// Frame returns the frame, or the zero ActFrame if out of range.
func (a *Act) Frame(action, frame int) ActFrame {
	if action < 0 || action >= len(a.Actions) || frame < 0 || frame >= len(a.Actions[action].Frames) {
		return ActFrame{}
	}
	return a.Actions[action].Frames[frame]
}

// Frames returns an action's frames, or nil if out of range.
func (a *Act) Frames(action int) []ActFrame {
	if action < 0 || action >= len(a.Actions) {
		return nil
	}
	return a.Actions[action].Frames
}

// Sprites returns the sprite layers of a frame, or nil if out of range.
func (a *Act) Sprites(action, frame int) []ActSprite {
	f := a.Frame(action, frame)
	return f.Sprites
}

// AttachPoint returns a frame's attach point, or the zero value if out of range.
func (a *Act) AttachPoint(action, frame, index int) ActAttachPoint {
	f := a.Frame(action, frame)
	if index < 0 || index >= len(f.AttachPoints) {
		return ActAttachPoint{}
	}
	return f.AttachPoints[index]
}

// AttachPoints returns a frame's attach points.
func (a *Act) AttachPoints(action, frame int) []ActAttachPoint {
	return a.Frame(action, frame).AttachPoints
}

// Interval returns an action's frame interval (ms-ish ticks), or 4 if out of range.
func (a *Act) Interval(action int) float32 {
	if action < 0 || action >= len(a.Actions) {
		return 4
	}
	return a.Actions[action].Interval
}

// colorFromAABBGGRR unpacks a little-endian uint (0xAABBGGRR) into a Color, the
// layout zrenderer's draw.Color uses for tints.
func colorFromAABBGGRR(v uint32) raster.Color {
	return raster.Color{
		R: uint8(v & 0xFF),
		G: uint8((v >> 8) & 0xFF),
		B: uint8((v >> 16) & 0xFF),
		A: uint8((v >> 24) & 0xFF),
	}
}
