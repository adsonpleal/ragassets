// Package encode turns rendered RawImage frames into PNG (single frame) or APNG
// (animation) bytes, matching zrenderer's output format and frame timing.
package encode

import (
	"bytes"
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
func Animation(frames []raster.RawImage, interval float32) ([]byte, error) {
	if len(frames) == 0 {
		return nil, nil
	}
	if len(frames) == 1 {
		return PNG(frames[0])
	}

	delayNum := uint16(25 * interval)
	a := apng.APNG{Frames: make([]apng.Frame, len(frames)), LoopCount: 0}
	for i, f := range frames {
		a.Frames[i] = apng.Frame{
			Image:            f.ToNRGBA(),
			DelayNumerator:   delayNum,
			DelayDenominator: 1000,
			BlendOp:          apng.BLEND_OP_SOURCE, // full-frame replace
			DisposeOp:        apng.DISPOSE_OP_NONE,
		}
	}
	var buf bytes.Buffer
	if err := apng.Encode(&buf, a); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
