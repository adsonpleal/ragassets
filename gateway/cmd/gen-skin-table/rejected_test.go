package main

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"

	"github.com/ragassets/gateway/internal/render/resource"
	"github.com/ragassets/gateway/internal/render/skin"
)

// TestDumpRejectedIndices renders the sprites whose isolated skin-coloured
// indices the adjacency test rejected, marking baked skin magenta and the
// rejected index green. Set SKIN_REJECT_DIR to write the PNGs.
//
// The question it answers: are those pixels the rider's skin (a miss) or the
// mount's own colouring (correctly left alone)? A poring is pink and a toad is
// brown, so colour alone cannot decide it — position can.
func TestDumpRejectedIndices(t *testing.T) {
	dir := os.Getenv("SKIN_REJECT_DIR")
	if dir == "" {
		t.Skip("set SKIN_REJECT_DIR to dump the rejected-index review sheet")
	}
	if _, err := os.Stat(resRoot + "/data"); err != nil {
		t.Skipf("resources not present: %v", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr := resource.NewManager(resRoot)

	cases := []struct {
		name     string
		rejected []int
	}{
		{"인간족/몸통/여/슈퍼노비스포링_여", []int{193, 199}},
		{"인간족/몸통/여/노비스포링_여", []int{199}},
		{"인간족/몸통/여/두꺼비닌자_여", []int{196}},
		{"인간족/몸통/여/frog_oboro_여", []int{196}},
		{"인간족/몸통/여/costume_1/그리폰가드_여_1", []int{249}},
		{"인간족/몸통/여/hyper_novice_riding_여", []int{199}},
	}

	const scale = 5
	type tile struct{ img *image.RGBA }
	var tiles []*image.RGBA
	maxW, maxH := 0, 0

	for _, c := range cases {
		spr, err := mgr.Spr(c.name)
		if err != nil {
			t.Logf("%s: %v", c.name, err)
			continue
		}
		baked := map[int]bool{}
		if slots, ok := skin.Body(c.name); ok {
			for _, s := range slots {
				baked[s.Index] = true
			}
		}
		rej := map[int]bool{}
		for _, i := range c.rejected {
			rej[i] = true
		}
		// Pick the image that draws the most of the rejected indices.
		best, bestN := 0, -1
		for img := 0; img < spr.ImageCount(0); img++ {
			idx, _, _ := spr.DecodeIndices(img)
			n := 0
			for _, v := range idx {
				if rej[int(v)] {
					n++
				}
			}
			if n > bestN {
				best, bestN = img, n
			}
		}
		idx, w, h := spr.DecodeIndices(best)
		pal := spr.Palette()
		im := image.NewRGBA(image.Rect(0, 0, w*scale, h*scale))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				v := int(idx[y*w+x])
				var col color.RGBA
				switch {
				case v == 0:
					col = color.RGBA{24, 24, 30, 255}
				case rej[v]:
					col = color.RGBA{0, 255, 0, 255}
				case baked[v]:
					col = color.RGBA{255, 0, 255, 255}
				default:
					p := pal[v]
					g := uint8(float64(p.R)*0.3+float64(p.G)*0.59+float64(p.B)*0.11)/2 + 40
					col = color.RGBA{g, g, g, 255}
				}
				for sy := 0; sy < scale; sy++ {
					for sx := 0; sx < scale; sx++ {
						im.SetRGBA(x*scale+sx, y*scale+sy, col)
					}
				}
			}
		}
		tiles = append(tiles, im)
		if im.Bounds().Dx() > maxW {
			maxW = im.Bounds().Dx()
		}
		if im.Bounds().Dy() > maxH {
			maxH = im.Bounds().Dy()
		}
		t.Logf("%s image %d: %d rejected px", c.name, best, bestN)
	}

	sheet := image.NewRGBA(image.Rect(0, 0, maxW*len(tiles), maxH))
	for i, im := range tiles {
		for y := 0; y < im.Bounds().Dy(); y++ {
			for x := 0; x < im.Bounds().Dx(); x++ {
				sheet.Set(i*maxW+x, y, im.At(x, y))
			}
		}
	}
	f, err := os.Create(dir + "/rejected_indices.png")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, sheet); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s/rejected_indices.png (magenta = baked skin, green = rejected index)", dir)
}
