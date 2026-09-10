// Package encode turns rendered RawImage frames into PNG (single frame) or APNG
// (animation) bytes, matching zrenderer's output format and frame timing.
package encode

import (
	"bytes"
	"image"
	"image/png"

	"github.com/kettek/apng"

	"github.com/ragassets/gateway/internal/render/raster"
)

// PNG encodes a single frame as a standard PNG.
func PNG(im raster.RawImage) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, im.ToNRGBA()); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Animation encodes frames as a PNG (one frame) or a looping APNG (more). The
// per-frame delay matches zrenderer: numerator = 25 * interval, denominator =
// 1000 (so each frame lasts interval*25 ms). interval is the action's frame
// interval from the ACT.
//
// Every frame after the first is written as its own dirty rectangle — the crop
// enclosing its visible pixels, placed back at an offset — rather than as a
// full-canvas repaint. The composited animation is identical either way, but
// deflate only sees the sprite instead of the transparent padding around it,
// and padding is most of a large canvas: a 24-frame 320x320 request whose body
// covers 55x110 spends around 90% of its render budget compressing nothing.
//
// The first frame stays full-size. It is the one the APNG spec pins to the
// canvas (its fcTL must cover the whole image) and it is also what the encoder
// takes IHDR's dimensions from, so cropping it would silently resize the output
// that the caller asked for by canvas=.
func Animation(frames []raster.RawImage, interval float32) ([]byte, error) {
	if len(frames) == 0 {
		return nil, nil
	}
	if len(frames) == 1 {
		return PNG(frames[0])
	}

	canvas := image.Rect(0, 0, frames[0].Width, frames[0].Height)
	delayNum := uint16(25 * interval)
	a := apng.APNG{Frames: make([]apng.Frame, len(frames)), LoopCount: 0}
	for i, f := range frames {
		rect := canvas
		if i > 0 {
			rect = dirtyRect(f, canvas)
		}
		a.Frames[i] = apng.Frame{
			Image:            f.ToNRGBARect(rect),
			XOffset:          rect.Min.X,
			YOffset:          rect.Min.Y,
			DelayNumerator:   delayNum,
			DelayDenominator: 1000,
			BlendOp:          apng.BLEND_OP_SOURCE, // the frame's pixels, alpha included, replace the region
			// Clearing each frame's region afterwards leaves the canvas fully
			// transparent before the next one draws, which is what makes a
			// partial frame mean "this is the whole picture" rather than "this
			// is a patch over the last one". With DISPOSE_OP_NONE the previous
			// frame would show through everywhere the new rectangle does not
			// reach.
			DisposeOp: apng.DISPOSE_OP_BACKGROUND,
		}
	}
	var buf bytes.Buffer
	if err := apng.Encode(&buf, a); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// dirtyRect is the region of f that has to be written: its visible pixels,
// clamped into canvas.
//
// Two cases fall back to the full canvas rather than a crop. A frame sized
// differently from the first one cannot be trusted to sit inside the canvas the
// header declares, and an odd-sized frame is rare enough that being exact beats
// being small. A fully transparent frame has no visible pixel to enclose, and
// APNG has no zero-sized frame, so it becomes a single transparent pixel — the
// smallest legal way to say "nothing here".
func dirtyRect(f raster.RawImage, canvas image.Rectangle) image.Rectangle {
	if f.Width != canvas.Dx() || f.Height != canvas.Dy() {
		return canvas
	}
	r := f.OpaqueBounds()
	if r.Empty() {
		return image.Rect(0, 0, 1, 1)
	}
	return r
}
