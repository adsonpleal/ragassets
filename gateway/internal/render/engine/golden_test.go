package engine

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/ragassets/gateway/internal/render/resolve"
)

// TestGolden renders a set of stills and compares them pixel-for-pixel against
// committed reference PNGs (themselves validated as pixel-identical to the
// upstream zrenderer). It guards against future regressions in the engine.
//
// Unlike the rest of this package's tests, it does NOT need the full resources/
// tree and never skips: it runs against testdata/fixtures, a committed 1.3 MB
// pack holding exactly the 19 files these six renders read. That matters because
// resources/ is gitignored, so on a fresh CI runner a resources-gated golden test
// would pass vacuously — and this comparison is the safety net the whole renderer
// rests on. It has to actually run.
//
// The pack also reproduces the tree's *existence* topology, which is load-bearing:
// loadGarment and loadHatEffect pick the first candidate whose files both exist,
// so a probe that must miss (아이템/고글_이펙트.act) is deliberately absent here too.
//
// To regenerate after a client update or a resolver change: re-copy every path the
// six cases touch out of resources/. If a change makes the engine probe a new path
// that exists in resources/ but not here, this test fails rather than silently
// diverging — that is the intended behaviour, and the fix is to refresh the pack.
func TestGolden(t *testing.T) {
	e := New(filepath.Join("testdata", "fixtures"), resolve.DefaultTables())

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
