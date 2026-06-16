package roformat

import "fmt"

// ParsePal parses a standalone .pal file: 256 RGBA entries (1024 bytes). Only the
// first 1024 bytes are read; extra trailing bytes (some .pal files carry them)
// are ignored, matching zrenderer's PaletteResource.
func ParsePal(buf []byte) (Palette, error) {
	if len(buf) < 1024 {
		return nil, fmt.Errorf("pal: too small (%d bytes, need >= 1024)", len(buf))
	}
	return parsePaletteBytes(buf[:1024]), nil
}
