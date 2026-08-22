// Package skin generates skin-tone ramps for player body/head sprites and holds
// the baked table that says where the skin ramp lives in each sprite's palette.
//
// Ragnarok Online has no skin-tone feature. Everything here is a fan-made
// capability of this gateway, derived from the sprites' own palettes.
package skin

import (
	"math"

	"github.com/ragassets/gateway/internal/render/raster"
)

// Colour work happens in Oklab, never HSL: darkening a skin ramp in HSL drags it
// toward grey and purple, because HSL "lightness" is not perceptual. Oklab keeps
// the hue and the perceived lightness separable, which is the whole point when
// the job is "same skin, less light".

// srgbToLinear / linearToSRGB are the sRGB electro-optical transfer functions.
func srgbToLinear(v float64) float64 {
	if v <= 0.04045 {
		return v / 12.92
	}
	return math.Pow((v+0.055)/1.055, 2.4)
}

func linearToSRGB(v float64) float64 {
	if v <= 0.0031308 {
		return 12.92 * v
	}
	return 1.055*math.Pow(v, 1.0/2.4) - 0.055
}

// lab is an Oklab colour: L (perceptual lightness, 0..1) plus the a/b opponent axes.
type lab struct{ L, A, B float64 }

// lch is Oklab in cylindrical form: L, chroma, hue in degrees.
type lch struct {
	L, C float64
	H    float64
}

func rgbToLab(r, g, b float64) lab {
	lr := srgbToLinear(r)
	lg := srgbToLinear(g)
	lb := srgbToLinear(b)

	l := math.Cbrt(0.4122214708*lr + 0.5363325363*lg + 0.0514459929*lb)
	m := math.Cbrt(0.2119034982*lr + 0.6806995451*lg + 0.1073969566*lb)
	s := math.Cbrt(0.0883024619*lr + 0.2817188376*lg + 0.6299787005*lb)

	return lab{
		L: 0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
		A: 1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
		B: 0.0259040371*l + 0.7827717662*m - 0.8086757660*s,
	}
}

// labToLinear returns linear-light RGB, which may fall outside [0,1] when the
// colour is out of the sRGB gamut. Callers decide what to do about that.
func labToLinear(c lab) (r, g, b float64) {
	l := c.L + 0.3963377774*c.A + 0.2158037573*c.B
	m := c.L - 0.1055613458*c.A - 0.0638541728*c.B
	s := c.L - 0.0894841775*c.A - 1.2914855480*c.B
	l, m, s = l*l*l, m*m*m, s*s*s

	r = +4.0767416621*l - 3.3077115913*m + 0.2309699292*s
	g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
	b = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
	return r, g, b
}

func labToLCH(c lab) lch {
	h := math.Atan2(c.B, c.A) * 180 / math.Pi
	if h < 0 {
		h += 360
	}
	return lch{L: c.L, C: math.Hypot(c.A, c.B), H: h}
}

func lchToLab(c lch) lab {
	rad := c.H * math.Pi / 180
	return lab{L: c.L, A: c.C * math.Cos(rad), B: c.C * math.Sin(rad)}
}

// colorToLCH converts an 8-bit colour to Oklab cylindrical form. Alpha is ignored.
func colorToLCH(c raster.Color) lch {
	return labToLCH(rgbToLab(float64(c.R)/255, float64(c.G)/255, float64(c.B)/255))
}

const gamutEpsilon = 1e-9

// inGamut reports whether an OkLCh colour survives conversion to sRGB unclipped.
func inGamut(c lch) bool {
	r, g, b := labToLinear(lchToLab(c))
	return r >= -gamutEpsilon && r <= 1+gamutEpsilon &&
		g >= -gamutEpsilon && g <= 1+gamutEpsilon &&
		b >= -gamutEpsilon && b <= 1+gamutEpsilon
}

// lchToColor converts to 8-bit sRGB, reducing chroma until the colour fits the
// gamut. Naively clamping each channel instead would shift hue and lightness —
// the two things the whole Oklab detour exists to preserve.
func lchToColor(c lch) raster.Color {
	c.L = clamp(c.L, 0, 1)
	if c.C < 0 {
		c.C = 0
	}
	if !inGamut(c) {
		lo, hi := 0.0, c.C
		for i := 0; i < 24; i++ {
			mid := (lo + hi) / 2
			if inGamut(lch{L: c.L, C: mid, H: c.H}) {
				lo = mid
			} else {
				hi = mid
			}
		}
		c.C = lo
	}
	r, g, b := labToLinear(lchToLab(c))
	return raster.Color{
		R: to8(linearToSRGB(clamp(r, 0, 1))),
		G: to8(linearToSRGB(clamp(g, 0, 1))),
		B: to8(linearToSRGB(clamp(b, 0, 1))),
		A: 0xFF,
	}
}

// Lightness returns a colour's perceptual (Oklab) lightness, 0..1. Exported for
// the offline table generator, which ranks pixels by how bright they are relative
// to the skin around them.
func Lightness(c raster.Color) float64 { return colorToLCH(c).L }

func to8(v float64) uint8 { return uint8(math.Round(clamp(v, 0, 1) * 255)) }

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// lerp interpolates across a piecewise-linear curve sampled at xs (ascending),
// clamping outside the sampled range.
func interp(xs, ys []float64, x float64) float64 {
	if x <= xs[0] {
		return ys[0]
	}
	last := len(xs) - 1
	if x >= xs[last] {
		return ys[last]
	}
	for i := 1; i <= last; i++ {
		if x <= xs[i] {
			span := xs[i] - xs[i-1]
			if span == 0 {
				return ys[i]
			}
			f := (x - xs[i-1]) / span
			return ys[i-1] + f*(ys[i]-ys[i-1])
		}
	}
	return ys[last]
}
