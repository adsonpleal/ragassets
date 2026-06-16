package engine

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// TestGolden renders a set of stills and compares them pixel-for-pixel against
// committed reference PNGs (themselves validated as pixel-identical to the
// upstream zrenderer). It guards against future regressions in the engine.
// Skipped when resources/ is absent.
func TestGolden(t *testing.T) {
	e := newEngine(t)

	cases := []struct {
		golden string
		req    Request
	}{
		{"swordman_stand", func() Request { r := baseReq(); r.Frame = 0; return r }()},
		{"swordman_female", func() Request { r := baseReq(); r.Frame = 0; r.Gender = 0; return r }()},
		{"swordman_goggles", func() Request { r := baseReq(); r.Frame = 0; r.Headgear = []uint32{1}; return r }()},
		{"swordman_garment245", func() Request { r := baseReq(); r.Frame = 0; r.Garment = 245; return r }()},
		{"dragonknight", func() Request { r := baseReq(); r.Frame = 0; r.Job = 4252; return r }()},
		{"monster_poring", func() Request { r := baseReq(); r.Frame = 0; r.Job = 1002; return r }()},
	}

	for _, c := range cases {
		t.Run(c.golden, func(t *testing.T) {
			res, err := e.Render(c.req)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if len(res.Frames) != 1 {
				t.Fatalf("expected 1 frame, got %d", len(res.Frames))
			}
			got := res.Frames[0].ToNRGBA()

			want := loadPNG(t, filepath.Join("testdata", "golden", c.golden+".png"))
			if got.Bounds() != want.Bounds() {
				t.Fatalf("bounds %v != golden %v (regenerate goldens?)", got.Bounds(), want.Bounds())
			}
			if !bytes.Equal(got.Pix, want.Pix) {
				t.Errorf("pixels differ from golden %s — engine output changed", c.golden)
			}
		})
	}
}

func loadPNG(t *testing.T, path string) *image.NRGBA {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v", path, err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode golden %s: %v", path, err)
	}
	// Normalize to NRGBA for a direct pixel comparison.
	out := image.NewNRGBA(img.Bounds())
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			out.Set(x, y, img.At(x, y))
		}
	}
	return out
}
