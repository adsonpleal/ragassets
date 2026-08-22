package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sort"

	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/skin"
)

// Review sheets. Detection here is heuristic, and heuristics on 84 sprites are
// checked by looking at them: every bug found in this feature so far was found by
// eye and missed by the automated counts. One tile per (head, image) that has any
// override, so nothing the bake touches goes unseen.

const (
	sheetScale = 5
	sheetCols  = 12
	sheetTileW = 40
	sheetTileH = 44
)

type sheetTile struct {
	head headSprite
	img  int
	runs []pixelRun
}

func writeSheets(dir, gender string, heads []headSprite, masks map[int]*faceMask, maxSide int) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var tiles []sheetTile
	for _, h := range heads {
		for img := 0; img < h.spr.ImageCount(0); img++ {
			runs := findRuns(h, img, masks[img], maxSide)
			if len(runs) > 0 {
				tiles = append(tiles, sheetTile{head: h, img: img, runs: mergeRuns(runs)})
			}
		}
	}
	sort.Slice(tiles, func(i, j int) bool {
		if tiles[i].head.name != tiles[j].head.name {
			return tiles[i].head.name < tiles[j].head.name
		}
		return tiles[i].img < tiles[j].img
	})

	tone, _ := skin.Preset(skin.PresetCount) // the most extreme tone shows problems first
	ramp := tone.Ramp()

	if err := drawSheet(filepath.Join(dir, "skin_review_"+gender+"_tone.png"), tiles, func(t sheetTile, idx byte, p int) (color.RGBA, bool) {
		pal := t.head.spr.Palette()
		for _, sl := range t.head.skin {
			if int(idx) == sl.Index {
				return rgba(ramp[sl.Slot]), true
			}
		}
		if c, ok := overrideAt(t, p, tone); ok {
			return rgba(c), true
		}
		return rgba(pal[idx]), true
	}); err != nil {
		return err
	}

	return drawSheet(filepath.Join(dir, "skin_review_"+gender+"_marks.png"), tiles, func(t sheetTile, idx byte, p int) (color.RGBA, bool) {
		if _, ok := overrideAt(t, p, tone); ok {
			return color.RGBA{0, 255, 0, 255}, true // green: repainted by the bake
		}
		for _, sl := range t.head.skin {
			if int(idx) == sl.Index {
				return color.RGBA{120, 40, 110, 255}, true // purple: plain skin
			}
		}
		c := t.head.spr.Palette()[idx]
		g := uint8(float64(c.R)*0.3+float64(c.G)*0.59+float64(c.B)*0.11)/3 + 30
		return color.RGBA{g, g, g, 255}, true
	})
}

func overrideAt(t sheetTile, p int, tone skin.Tone) (raster.Color, bool) {
	for _, r := range t.runs {
		for _, o := range r.offsets {
			if int(o) == p {
				return tone.ColorAt(float64(r.tMilli) / 1000), true
			}
		}
	}
	return raster.Color{}, false
}

func rgba(c raster.Color) color.RGBA { return color.RGBA{c.R, c.G, c.B, 255} }

func drawSheet(path string, tiles []sheetTile, pix func(sheetTile, byte, int) (color.RGBA, bool)) error {
	rows := (len(tiles) + sheetCols - 1) / sheetCols
	if rows == 0 {
		rows = 1
	}
	w := sheetCols * sheetTileW * sheetScale
	h := rows * sheetTileH * sheetScale
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 0
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			cell := (x/(sheetTileW*sheetScale) + y/(sheetTileH*sheetScale)) % 2
			v := uint8(26)
			if cell == 1 {
				v = 34
			}
			img.SetRGBA(x, y, color.RGBA{v, v, v + 6, 255})
		}
	}

	for n, t := range tiles {
		idx, iw, ih := t.head.spr.DecodeIndices(t.img)
		if idx == nil {
			continue
		}
		ox := (n%sheetCols)*sheetTileW*sheetScale + (sheetTileW*sheetScale-iw*sheetScale)/2
		oy := (n/sheetCols)*sheetTileH*sheetScale + 2*sheetScale
		for y := 0; y < ih; y++ {
			for x := 0; x < iw; x++ {
				p := y*iw + x
				if idx[p] == 0 {
					continue
				}
				c, ok := pix(t, idx[p], p)
				if !ok {
					continue
				}
				for sy := 0; sy < sheetScale; sy++ {
					for sx := 0; sx < sheetScale; sx++ {
						px, py := ox+x*sheetScale+sx, oy+y*sheetScale+sy
						if px >= 0 && py >= 0 && px < w && py < h {
							img.SetRGBA(px, py, c)
						}
					}
				}
			}
		}
	}

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %s (%d tiles)\n", path, len(tiles))
	return nil
}
