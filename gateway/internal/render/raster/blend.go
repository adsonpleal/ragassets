package raster

// AlphaBlend composites src over dest using zrenderer's exact integer formula
// (renderer.d alphaBlend). The fast paths (transparent dest or opaque src) take
// src verbatim; otherwise channels are un-premultiplied against the new alpha.
func AlphaBlend(dest, src Color) Color {
	if dest.A == 0x00 || src.A == 0xFF {
		return src
	}
	sa := int(src.A)
	da := int(dest.A)
	newAlpha := sa + (da * (0xFF - sa) / 0xFF)
	if newAlpha == 0 {
		return Color{}
	}
	ch := func(s, d int) uint8 {
		v := (s*sa/0xFF + (d * da * (0xFF - sa) / (0xFF * 0xFF))) * 0xFF / newAlpha
		return uint8(v)
	}
	return Color{
		R: ch(int(src.R), int(dest.R)),
		G: ch(int(src.G), int(dest.G)),
		B: ch(int(src.B), int(dest.B)),
		A: uint8(newAlpha),
	}
}

// TintPixel multiplies a pixel by a tint color, per channel (renderer.d tintPixel).
// A white opaque tint (0xFFFFFFFF) leaves the pixel unchanged.
func TintPixel(pixel, tint Color) Color {
	return Color{
		R: uint8(int(tint.R) * int(pixel.R) / 0xFF),
		G: uint8(int(tint.G) * int(pixel.G) / 0xFF),
		B: uint8(int(tint.B) * int(pixel.B) / 0xFF),
		A: uint8(int(tint.A) * int(pixel.A) / 0xFF),
	}
}
