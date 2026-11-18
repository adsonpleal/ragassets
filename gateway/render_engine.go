// Rendering: query params → engine.Request → in-process render → PNG/APNG/ZIP
// bytes. This replaces the previous HTTP round-trip to the external zrenderer
// container; all sprite rendering now happens in this process (internal/render).
package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"

	"github.com/ragassets/gateway/internal/api"
	"github.com/ragassets/gateway/internal/render/encode"
	"github.com/ragassets/gateway/internal/render/engine"
	"github.com/ragassets/gateway/internal/render/raster"
)

func (s *server) renderImage(req engine.Request, ext string, fr api.Foreign) ([]byte, error) {
	eng, tables, err := s.renderFor(fr)
	if err != nil {
		return nil, err
	}
	// tables is nil for the ordinary (LATAM) path, where the engine's own
	// tables are the right ones; it is non-nil only when a request named the
	// sprites itself, which is how a foreign costume is addressed at all.
	var res *engine.Result
	if tables == nil {
		res, err = eng.Render(req)
	} else {
		res, err = eng.RenderWithTables(req, tables)
	}
	if err != nil {
		return nil, err
	}
	if len(res.Frames) == 0 {
		return nil, errors.New("render produced no frames")
	}

	if ext == ".zip" {
		return zipFrames(res.Frames)
	}
	return encode.Animation(res.Frames, res.IntervalMs)
}

// zipFrames packs each frame as <index>.png into a zip archive (zrenderer's
// outputFormat=zip behavior).
func zipFrames(frames []raster.RawImage) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i, f := range frames {
		png, err := encode.PNG(f)
		if err != nil {
			return nil, err
		}
		w, err := zw.Create(fmt.Sprintf("%d.png", i))
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(png); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
