// GIF output: the only image processing this gateway does.
//
// zrenderer always emits PNG/APNG. The /gif endpoint renders the exact same
// thing, then converts it here so callers that can't use APNG (older tooling,
// chat embeds, some social previews) get a plain animated GIF instead.
//
// The conversion composites every APNG frame onto a full-size RGBA canvas
// (honoring per-frame offsets, blend and dispose ops), quantizes each composited
// frame to its own ≤256-color palette with a reserved transparent slot, and
// writes a looping GIF. GIF transparency is a single palette index, so the
// sprite's soft (antialiased) edges become hard-edged — that's inherent to the
// format, not a bug.
package main

import (
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"io"
	"os"
	"path/filepath"

	"github.com/ericpauley/go-quantize/quantize"
	"github.com/kettek/apng"
)

// gifAlphaThreshold is the 16-bit alpha at/below which a pixel becomes the
// transparent GIF index. GIF has no partial transparency, so we pick a 50% cut.
const gifAlphaThreshold = 0x8000

// apngFileToGIF decodes the PNG/APNG at srcPath and writes a GIF to dstPath
// atomically (temp file + rename). A normal single-image PNG yields a one-frame
// GIF; a multi-frame APNG yields an animated, infinitely-looping GIF.
func apngFileToGIF(srcPath, dstPath string) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("opening render output %q: %w", srcPath, err)
	}
	defer f.Close()

	g, err := apngToGIF(f)
	if err != nil {
		return fmt.Errorf("converting APNG to GIF: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(dstPath), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename

	if err := gif.EncodeAll(tmp, g); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, dstPath)
}

// apngToGIF builds a *gif.GIF from an (A)PNG stream.
func apngToGIF(r io.Reader) (*gif.GIF, error) {
	a, err := apng.DecodeAll(r)
	if err != nil {
		return nil, err
	}
	if len(a.Frames) == 0 {
		return nil, errors.New("image has no frames")
	}

	// Canvas = the bounding box that holds every frame at its offset.
	w, h := 0, 0
	for _, fr := range a.Frames {
		b := fr.Image.Bounds()
		if right := fr.XOffset + b.Dx(); right > w {
			w = right
		}
		if bottom := fr.YOffset + b.Dy(); bottom > h {
			h = bottom
		}
	}
	rect := image.Rect(0, 0, w, h)

	out := &gif.GIF{
		Config:    image.Config{Width: w, Height: h},
		LoopCount: 0, // 0 = loop forever
	}

	canvas := image.NewRGBA(rect) // frames are composited onto this
	var saved *image.RGBA         // canvas snapshot for DISPOSE_OP_PREVIOUS
	quant := quantize.MedianCutQuantizer{AddTransparent: true}

	for i, fr := range a.Frames {
		src := fr.Image
		sb := src.Bounds()
		region := image.Rect(fr.XOffset, fr.YOffset, fr.XOffset+sb.Dx(), fr.YOffset+sb.Dy())

		if fr.DisposeOp == apng.DISPOSE_OP_PREVIOUS {
			saved = cloneRGBA(canvas)
		}

		// Blend this frame's sub-region onto the canvas.
		if fr.BlendOp == apng.BLEND_OP_OVER {
			draw.Draw(canvas, region, src, sb.Min, draw.Over)
		} else { // BLEND_OP_SOURCE
			draw.Draw(canvas, region, src, sb.Min, draw.Src)
		}

		// Snapshot the whole canvas as one paletted GIF frame.
		pal := quant.Quantize(make(color.Palette, 0, 256), canvas)
		transIdx := transparentIndex(pal)
		frame := image.NewPaletted(rect, pal)
		drawPaletted(frame, canvas, pal, transIdx)

		out.Image = append(out.Image, frame)
		out.Delay = append(out.Delay, frameDelayCentis(fr))
		// Each GIF frame is a full-canvas snapshot, so clear back to (transparent)
		// background before the next one — otherwise moving sprites leave trails.
		out.Disposal = append(out.Disposal, gif.DisposalBackground)
		if i == 0 && transIdx >= 0 {
			out.BackgroundIndex = uint8(transIdx)
		}

		// Apply this frame's dispose op to the canvas for the next iteration.
		switch fr.DisposeOp {
		case apng.DISPOSE_OP_BACKGROUND:
			draw.Draw(canvas, region, image.Transparent, image.Point{}, draw.Src)
		case apng.DISPOSE_OP_PREVIOUS:
			if saved != nil {
				canvas = saved
			}
		}
	}
	return out, nil
}

// transparentIndex returns the index of the palette's fully-transparent entry,
// or -1 if there is none. go-quantize appends it last when AddTransparent is set.
func transparentIndex(pal color.Palette) int {
	for i, c := range pal {
		if _, _, _, a := c.RGBA(); a == 0 {
			return i
		}
	}
	return -1
}

// drawPaletted maps the RGBA canvas into a paletted frame. Pixels at/under the
// alpha threshold get the transparent index; the rest snap to the nearest opaque
// palette color (alpha is excluded from that match so edges don't bleed away).
func drawPaletted(dst *image.Paletted, src *image.RGBA, pal color.Palette, transIdx int) {
	opaque := pal
	if transIdx == len(pal)-1 && transIdx >= 0 {
		opaque = pal[:transIdx] // transparent entry is last; drop it for matching
	}
	if len(opaque) == 0 {
		opaque = pal
	}
	b := dst.Rect
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			c := src.RGBAAt(x, y)
			if transIdx >= 0 && uint32(c.A)*0x101 <= gifAlphaThreshold {
				dst.SetColorIndex(x, y, uint8(transIdx))
				continue
			}
			dst.SetColorIndex(x, y, uint8(opaque.Index(c)))
		}
	}
}

// frameDelayCentis converts an APNG frame delay to GIF centiseconds (1/100 s).
func frameDelayCentis(fr apng.Frame) int {
	den := int(fr.DelayDenominator)
	if den == 0 {
		den = 100 // APNG: a 0 denominator means 1/100 s
	}
	cs := int(fr.DelayNumerator) * 100 / den
	if cs < 2 {
		cs = 2 // many GIF players treat <2 as "fast as possible"; keep a floor
	}
	return cs
}

func cloneRGBA(src *image.RGBA) *image.RGBA {
	dst := image.NewRGBA(src.Rect)
	copy(dst.Pix, src.Pix)
	return dst
}
