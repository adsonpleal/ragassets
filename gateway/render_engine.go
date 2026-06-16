// Rendering: query params → engine.Request → in-process render → PNG/APNG/ZIP
// bytes. This replaces the previous HTTP round-trip to the external zrenderer
// container; all sprite rendering now happens in this process (internal/render).
package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"net/url"

	"github.com/ragassets/zrenderer-gateway/internal/render/encode"
	"github.com/ragassets/zrenderer-gateway/internal/render/engine"
	"github.com/ragassets/zrenderer-gateway/internal/render/raster"
	"github.com/ragassets/zrenderer-gateway/internal/render/rotype"
)

// buildRequest converts incoming query params into an engine.Request and returns
// the output file extension (".png" for image/APNG, ".zip" for a frame archive).
//
// Still-vs-animation rule (matches the previous gateway behavior):
//   - frame present                → still image (that frame)
//   - frame absent, action present → animation (APNG of all frames)
//   - frame absent, action absent  → still image (frame 0)
func buildRequest(q url.Values) (engine.Request, string, error) {
	var req engine.Request

	jobs := splitCSV(q.Get("job"))
	if len(jobs) == 0 {
		return req, "", errors.New("missing required 'job' parameter, e.g. /image?job=1002")
	}
	job, err := parseInt("job", jobs[0]) // one image per request; first job wins
	if err != nil {
		return req, "", err
	}
	req.Job = uint32(job)

	// Integer params with defaults.
	req.Head = 1
	req.BodyPalette = -1
	req.HeadPalette = -1
	req.EnableShadow = true
	req.HeadDir = rotype.All

	intInto := func(name string, dst *int) error {
		if q.Has(name) {
			n, err := parseInt(name, q.Get(name))
			if err != nil {
				return err
			}
			*dst = n
		}
		return nil
	}
	uintInto := func(name string, dst *uint32) error {
		if q.Has(name) {
			n, err := parseInt(name, q.Get(name))
			if err != nil {
				return err
			}
			*dst = uint32(n)
		}
		return nil
	}

	var action int
	for _, e := range []error{
		uintInto("head", &req.Head),
		uintInto("outfit", &req.Outfit),
		uintInto("garment", &req.Garment),
		uintInto("weapon", &req.Weapon),
		uintInto("shield", &req.Shield),
		intInto("action", &action),
		intInto("bodyPalette", &req.BodyPalette),
		intInto("headPalette", &req.HeadPalette),
	} {
		if e != nil {
			return req, "", e
		}
	}
	req.Action = uint(action)

	// headgear: comma-separated ids (the engine uses up to 3).
	if q.Has("headgear") {
		for _, part := range splitCSV(q.Get("headgear")) {
			n, err := parseInt("headgear", part)
			if err != nil {
				return req, "", err
			}
			req.Headgear = append(req.Headgear, uint32(n))
		}
	}

	// headgearBehind: comma-separated headgear ids that should render behind the
	// character (effect-type accessories such as auras/halos).
	if q.Has("headgearBehind") {
		for _, part := range splitCSV(q.Get("headgearBehind")) {
			n, err := parseInt("headgearBehind", part)
			if err != nil {
				return req, "", err
			}
			req.HeadgearBehind = append(req.HeadgearBehind, uint32(n))
		}
	}

	if q.Has("gender") {
		n, err := parseEnum("gender", q.Get("gender"), map[string]int{"female": 0, "male": 1}, []int{0, 1})
		if err != nil {
			return req, "", err
		}
		req.Gender = rotype.Gender(n)
	} else {
		req.Gender = rotype.Male
	}

	// headdir enum. NOTE: these match zrenderer's real HeadDirection ordinals
	// (straight=0, left=1, right=2, all=3) — the previous map swapped left/right.
	if q.Has("headdir") {
		n, err := parseEnum("headdir", q.Get("headdir"),
			map[string]int{"straight": 0, "left": 1, "right": 2, "all": 3}, []int{0, 1, 2, 3})
		if err != nil {
			return req, "", err
		}
		req.HeadDir = rotype.HeadDirection(n)
	}

	if q.Has("madogearType") {
		n, err := parseEnum("madogearType", q.Get("madogearType"),
			map[string]int{"robot": 0, "unused": 1, "suit": 2}, []int{0, 1, 2})
		if err != nil {
			return req, "", err
		}
		req.Madogear = rotype.MadogearType(n)
	}

	if q.Has("enableShadow") {
		b, err := parseBool("enableShadow", q.Get("enableShadow"))
		if err != nil {
			return req, "", err
		}
		req.EnableShadow = b
	}

	req.Canvas = q.Get("canvas")

	// Still-vs-animation rule.
	switch {
	case q.Has("frame"):
		n, err := parseInt("frame", q.Get("frame"))
		if err != nil {
			return req, "", err
		}
		req.Frame = n
	case q.Has("action"):
		req.Frame = -1 // animation
	default:
		req.Frame = 0 // single still
	}

	ext := ".png"
	if q.Has("outputFormat") {
		n, err := parseEnum("outputFormat", q.Get("outputFormat"),
			map[string]int{"png": 0, "zip": 1}, []int{0, 1})
		if err != nil {
			return req, "", err
		}
		if n == 1 {
			ext = ".zip"
		}
	}

	return req, ext, nil
}

// renderImage renders a request to encoded bytes: a PNG (single frame), a looping
// APNG (animation), or a ZIP of per-frame PNGs when ext is ".zip".
func (s *server) renderImage(req engine.Request, ext string) ([]byte, error) {
	res, err := s.eng.Render(req)
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
