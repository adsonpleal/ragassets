package engine

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ragassets/gateway/internal/render/encode"
	"github.com/ragassets/gateway/internal/render/raster"
	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/rotype"
)

func newEngine(t *testing.T) *Engine {
	t.Helper()
	root := filepath.Join("..", "..", "..", "..", "resources")
	if _, err := os.Stat(filepath.Join(root, "data")); err != nil {
		t.Skipf("resources not present: %v", err)
	}
	return New(root, resolve.DefaultTables())
}

func framesEqual(a, b raster.RawImage) bool {
	if a.Width != b.Width || a.Height != b.Height || len(a.Pixels) != len(b.Pixels) {
		return false
	}
	for i := range a.Pixels {
		if a.Pixels[i] != b.Pixels[i] {
			return false
		}
	}
	return true
}

func allFramesEqual(fs []raster.RawImage) bool {
	for i := 1; i < len(fs); i++ {
		if !framesEqual(fs[0], fs[i]) {
			return false
		}
	}
	return true
}

func opaqueCount(im raster.RawImage) int {
	n := 0
	for _, p := range im.Pixels {
		if p.A != 0 {
			n++
		}
	}
	return n
}

func baseReq() Request {
	return Request{
		Job:          1, // swordman (3-frame idle head)
		Gender:       rotype.Male,
		Head:         1,
		Action:       0,  // stand
		Frame:        -1, // animation
		BodyPalette:  -1,
		HeadPalette:  -1,
		HeadDir:      rotype.All,
		EnableShadow: false, // isolate body+head
	}
}

func render(t *testing.T, e *Engine, hd rotype.HeadDirection) []raster.RawImage {
	t.Helper()
	req := baseReq()
	req.HeadDir = hd
	res, err := e.Render(req)
	if err != nil {
		t.Fatalf("Render(headdir=%d): %v", hd, err)
	}
	if len(res.Frames) == 0 {
		t.Fatalf("Render(headdir=%d): no frames", hd)
	}
	return res.Frames
}

func TestRenderBasic(t *testing.T) {
	e := newEngine(t)
	req := baseReq()
	req.Frame = 0 // single still
	res, err := e.Render(req)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if len(res.Frames) != 1 {
		t.Fatalf("still render produced %d frames, want 1", len(res.Frames))
	}
	if opaqueCount(res.Frames[0]) == 0 {
		t.Error("rendered still is fully transparent")
	}
}

// TestHeadDirFix is the acceptance test for the head-direction fix: straight
// must NOT cycle (no looping head), all DOES cycle, and the three fixed
// directions render distinct head facings. Crucially the animation is not
// collapsed to a forced single frame the way the rejected overwriteFrame did.
func TestHeadDirFix(t *testing.T) {
	e := newEngine(t)

	straight := render(t, e, rotype.Straight)
	all := render(t, e, rotype.All)
	left := render(t, e, rotype.Left)
	right := render(t, e, rotype.Right)

	// straight: head is pinned, so the looking-around animation is gone — every
	// frame is identical (front-facing, not cycling).
	if !allFramesEqual(straight) {
		t.Error("straight head cycles (frames differ) — should be pinned/front-facing")
	}

	// all: the legacy looking-around animation, so frames must differ.
	if allFramesEqual(all) {
		t.Error("all head does not cycle (frames identical) — expected looking-around animation")
	}

	// straight must differ from all (it is not just the default).
	if framesEqual(lastFrame(straight), lastFrame(all)) {
		t.Error("straight last frame equals all last frame — straight not honored")
	}

	// The three pinned directions must render distinct head facings.
	if framesEqual(straight[0], left[0]) {
		t.Error("straight == left (head direction not honored)")
	}
	if framesEqual(left[0], right[0]) {
		t.Error("left == right (head direction not honored)")
	}
	if framesEqual(straight[0], right[0]) {
		t.Error("straight == right (head direction not honored)")
	}
}

func lastFrame(fs []raster.RawImage) raster.RawImage { return fs[len(fs)-1] }

func TestWalkAnimates(t *testing.T) {
	e := newEngine(t)
	req := baseReq()
	req.Action = 8 // walk (south) — always multi-frame, head follows body
	res, err := e.Render(req)
	if err != nil {
		t.Fatalf("Render(walk): %v", err)
	}
	if len(res.Frames) < 2 {
		t.Fatalf("walk produced %d frames, want >= 2", len(res.Frames))
	}
	if allFramesEqual(res.Frames) {
		t.Error("walk frames are all identical — body should animate")
	}
}

// TestDumpVisual renders a few cases to PNG/APNG for manual inspection. It only
// runs when RENDER_DUMP_DIR is set (skipped in normal/CI runs).
func TestDumpVisual(t *testing.T) {
	dir := os.Getenv("RENDER_DUMP_DIR")
	if dir == "" {
		t.Skip("set RENDER_DUMP_DIR to dump visual samples")
	}
	e := newEngine(t)
	cases := []struct {
		name string
		req  Request
	}{
		{"swordman_still", func() Request { r := baseReq(); r.Frame = 0; return r }()},
		{"swordman_straight", func() Request { r := baseReq(); r.HeadDir = rotype.Straight; return r }()},
		{"swordman_all", func() Request { r := baseReq(); r.HeadDir = rotype.All; return r }()},
		{"swordman_left", func() Request { r := baseReq(); r.HeadDir = rotype.Left; return r }()},
		{"swordman_right", func() Request { r := baseReq(); r.HeadDir = rotype.Right; return r }()},
		{"swordman_walk", func() Request { r := baseReq(); r.Action = 8; return r }()},
	}
	for _, c := range cases {
		res, err := e.Render(c.req)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		data, err := encode.Animation(res.Frames, res.IntervalMs)
		if err != nil {
			t.Fatalf("%s encode: %v", c.name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, c.name+".png"), data, 0o644); err != nil {
			t.Fatalf("%s write: %v", c.name, err)
		}
		t.Logf("%s: %d frames, %d bytes", c.name, len(res.Frames), len(data))
	}
}

// TestDumpMatrix renders a matrix of cases and writes a manifest mapping each
// output file to the equivalent live-gateway query, for an external pixel-parity
// comparison. Gated by RENDER_DUMP_DIR.
func TestDumpMatrix(t *testing.T) {
	dir := os.Getenv("RENDER_DUMP_DIR")
	if dir == "" {
		t.Skip("set RENDER_DUMP_DIR to dump the parity matrix")
	}
	e := newEngine(t)

	type caseT struct {
		name  string
		query string
		req   Request
	}
	var cases []caseT
	add := func(action uint, frame int) {
		name := "j1_a" + itoaT(int(action)) + "_f" + itoaT(frame)
		q := "job=1&gender=male&head=1&action=" + itoaT(int(action)) + "&frame=" + itoaT(frame) + "&enableShadow=false"
		r := baseReq()
		r.Action = action
		r.Frame = frame
		cases = append(cases, caseT{name, q, r})
	}
	// Stand (0..7), walk (8..15), sit (16..23): a few directions each, frame 0.
	for _, base := range []uint{0, 8, 16} {
		for _, dir := range []uint{0, 2, 4, 6} {
			add(base+dir, 0)
		}
	}
	// A couple of explicit walk frames to exercise animation frame selection.
	add(8, 1)
	add(8, 3)

	// Headgear and garment cases (use the real client tables).
	addHG := func(name string, headgear []uint32, garment uint32) {
		q := "job=1&gender=male&head=1&action=0&frame=0&enableShadow=false"
		if len(headgear) > 0 {
			q += "&headgear="
			for i, hg := range headgear {
				if i > 0 {
					q += ","
				}
				q += itoaT(int(hg))
			}
		}
		if garment > 0 {
			q += "&garment=" + itoaT(int(garment))
		}
		r := baseReq()
		r.Frame = 0
		r.Headgear = headgear
		r.Garment = garment
		cases = append(cases, caseT{name, q, r})
	}
	addHG("j1_goggles", []uint32{1}, 0)     // 고글
	addHG("j1_hg2", []uint32{2}, 0)         // 바이저
	addHG("j1_hg_multi", []uint32{1, 2}, 0) // two headgears
	addHG("j1_garment245", nil, 245)        // c_pitaya_r_bag (red basket)

	// Breadth: other job families / genders / palettes (all stills, no shadow).
	addCase := func(name, query string, mut func(*Request)) {
		r := baseReq()
		r.Frame = 0
		mut(&r)
		cases = append(cases, caseT{name, query, r})
	}
	addCase("monster_poring", "job=1002&action=0&frame=0&enableShadow=false",
		func(r *Request) { r.Job = 1002 })
	addCase("dragonknight", "job=4252&gender=male&head=1&action=0&frame=0&enableShadow=false",
		func(r *Request) { r.Job = 4252 })
	addCase("baby_swordman", "job=4024&gender=male&head=1&action=0&frame=0&enableShadow=false",
		func(r *Request) { r.Job = 4024 })
	addCase("doram", "job=4218&gender=male&head=1&action=0&frame=0&enableShadow=false",
		func(r *Request) { r.Job = 4218 })
	addCase("swordman_female", "job=1&gender=female&head=1&action=0&frame=0&enableShadow=false",
		func(r *Request) { r.Gender = rotype.Female })
	addCase("swordman_bodypal", "job=1&gender=male&head=1&action=0&frame=0&enableShadow=false&bodyPalette=1",
		func(r *Request) { r.BodyPalette = 1 })

	var manifest []string
	for _, c := range cases {
		res, err := e.Render(c.req)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		data, err := encode.Animation(res.Frames, res.IntervalMs)
		if err != nil {
			t.Fatalf("%s encode: %v", c.name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, c.name+".png"), data, 0o644); err != nil {
			t.Fatal(err)
		}
		manifest = append(manifest, c.name+"\t"+c.query)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.tsv"), []byte(joinLines(manifest)), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("dumped %d cases", len(cases))
}

func itoaT(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

func joinLines(s []string) string {
	out := ""
	for _, l := range s {
		out += l + "\n"
	}
	return out
}

func TestParseCanvas(t *testing.T) {
	c, ok := ParseCanvas("200x250+100+125")
	if !ok || c != (Canvas{Width: 200, Height: 250, OriginX: 100, OriginY: 125}) {
		t.Errorf("ParseCanvas = %+v ok=%v", c, ok)
	}
	if c, ok := ParseCanvas("120x120-60-60"); !ok || c.OriginX != -60 || c.OriginY != -60 {
		t.Errorf("negative origin = %+v ok=%v", c, ok)
	}
	if _, ok := ParseCanvas("garbage"); ok {
		t.Error("expected malformed canvas to fail")
	}
	if c, ok := ParseCanvas(""); !ok || !c.IsZero() {
		t.Error("empty canvas should be zero/auto")
	}
}
