// Package raster holds the engine's pixel primitives: an RGBA color, a simple
// CPU image buffer (RawImage), and the compositing/blend operations. It mirrors
// zrenderer's draw.color / draw.rawimage modules.
package raster

// Color is a straight RGBA8888 pixel. zrenderer stores this packed into a single
// uint as 0xAABBGGRR (memory order R,G,B,A); we keep the channels explicit and
// match its semantics in the parsers and blend code.
type Color struct {
	R, G, B, A uint8
}

// Transparent reports whether the pixel is fully transparent (alpha 0). Such
// pixels are skipped during compositing, matching zrenderer.
func (c Color) Transparent() bool { return c.A == 0 }

// WithAlpha returns a copy of the color with its alpha replaced.
func (c Color) WithAlpha(a uint8) Color { c.A = a; return c }
