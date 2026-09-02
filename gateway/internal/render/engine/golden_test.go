package engine

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/resource"
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

	for _, c := range goldenCases() {
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

type goldenCase struct {
	golden string
	req    Request
}

// goldenCases is shared by both golden tests so the on-disk and prefetched paths
// can never drift to covering different renders.
func goldenCases() []goldenCase {
	return []goldenCase{
		{"swordman_stand", func() Request { r := baseReq(); r.Frame = 0; return r }()},
		{"swordman_female", func() Request { r := baseReq(); r.Frame = 0; r.Gender = 0; return r }()},
		{"swordman_goggles", func() Request { r := baseReq(); r.Frame = 0; r.Headgear = []uint32{1}; return r }()},
		{"swordman_garment245", func() Request { r := baseReq(); r.Frame = 0; r.Garment = 245; return r }()},
		{"dragonknight", func() Request { r := baseReq(); r.Frame = 0; r.Job = 4252; return r }()},
		{"monster_poring", func() Request { r := baseReq(); r.Frame = 0; r.Job = 1002; return r }()},
	}
}

// forbiddenExistence fails the test if anything probes for a file. RenderPlanned
// must make no existence checks at all — every such decision belongs to
// BuildPlan — and this is what proves it rather than assuming it.
type forbiddenExistence struct{ t *testing.T }

func (f forbiddenExistence) Has(key string) bool {
	f.t.Helper()
	f.t.Fatalf("RenderPlanned probed for %q; all existence checks belong in BuildPlan", key)
	return false
}

// TestGoldenThroughPrefetchedSource is the acceptance test for the split between
// planning and rendering, and the gate for moving the renderer off a local disk.
//
// It renders each golden case the way a Workers build will have to: resolve the
// plan, fetch exactly the keys the plan names into memory, then render from that
// map with no filesystem underneath. Passing proves three things at once —
// Plan.Keys is complete (a missing key fails the render or changes the pixels),
// RenderPlanned needs no probes, and the result is byte-identical to rendering
// straight off disk.
func TestGoldenThroughPrefetchedSource(t *testing.T) {
	root := filepath.Join("testdata", "fixtures")
	tables := resolve.DefaultTables()

	// Planning still uses the real tree, exactly as a Worker would consult a
	// baked existence manifest.
	planner := New(root, tables)

	for _, c := range goldenCases() {
		t.Run(c.golden, func(t *testing.T) {
			p := planner.Plan(c.req)
			if len(p.Keys) == 0 {
				t.Fatal("plan resolved no keys")
			}

			// Fetch only what the plan asked for. Keys that do not exist are
			// skipped, mirroring a fetcher that filters by its manifest — the
			// engine already tolerates those misses.
			fs := resource.FSSource{Root: root}
			src := resource.MapSource{}
			for _, k := range p.Keys {
				if b, err := fs.Get(k); err == nil {
					src[k] = b
				}
			}

			e := NewWithSource(src, forbiddenExistence{t}, tables)
			res, err := e.RenderPlanned(c.req, p)
			if err != nil {
				t.Fatalf("render from prefetched source: %v", err)
			}
			if len(res.Frames) != 1 {
				t.Fatalf("expected 1 frame, got %d", len(res.Frames))
			}

			got := res.Frames[0].ToNRGBA()
			want := loadPNG(t, filepath.Join("testdata", "golden", c.golden+".png"))
			if got.Bounds() != want.Bounds() {
				t.Fatalf("bounds %v != golden %v", got.Bounds(), want.Bounds())
			}
			if !bytes.Equal(got.Pix, want.Pix) {
				t.Errorf("pixels differ from golden %s when rendered from a prefetched source", c.golden)
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
