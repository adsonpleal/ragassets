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

// TestParseCanvasRejects covers the grammar edges the regexp used to enforce, so
// the hand-written parser that replaced it cannot quietly get looser.
func TestParseCanvasRejects(t *testing.T) {
	bad := []string{
		"garbage",
		"200x250",          // missing both origins
		"200x250+100",      // missing one origin
		"200x250 100+125",  // wrong delimiter
		"200x250+100+125x", // trailing junk
		"x250+100+125",     // missing width
		"200x+100+125",     // missing height
		"200X250+100+125",  // capital X — the regexp was case-sensitive
		"200x250100+125",   // unsigned first origin
		"200x250++100+125",
		"-200x250+100+125", // signed width
		"200x250+100+125 ", // trailing space
		" 200x250+100+125", // leading space
	}
	for _, s := range bad {
		if c, ok := ParseCanvas(s); ok {
			t.Errorf("ParseCanvas(%q) = %+v, want rejected", s, c)
		}
	}
}

// TestParseCanvasBoundsDimensions guards against a canvas large enough to OOM the
// process. Width*Height flows into raster.NewRawImage, which allocates 4 bytes a
// pixel with no ceiling of its own, so an unbounded parse turns one query string
// into a multi-gigabyte allocation.
func TestParseCanvasBoundsDimensions(t *testing.T) {
	huge := []string{
		"50000x50000+0+0", // ~10 GB
		"99999x1+0+0",     // over the per-side cap
		"1x99999+0+0",
		"4000x4000+0+0",    // within per-side, but 64 MB — over the pixel cap
		"9999999999x1+0+0", // digit-run overflow
		"1x1+9999999999+0", // overflow in an origin
	}
	for _, s := range huge {
		if c, ok := ParseCanvas(s); ok {
			t.Errorf("ParseCanvas(%q) = %+v, want rejected as oversized", s, c)
		}
	}

	// The largest canvas that is still allowed must keep working.
	if c, ok := ParseCanvas("2048x2048+0+0"); !ok || c.Width != 2048 || c.Height != 2048 {
		t.Errorf("2048x2048 should be accepted, got %+v ok=%v", c, ok)
	}
}

// TestGarmentPrefersPerJobAct guards the garment resolution order. A few
// costumes (wing_of_angel_move / garment 61 among them) ship a complete
// act+spr pair at the folder root whose offsets place the sprite ~28px too
// high on a player body, alongside the correct per-job acts that share the
// root spr as their image bank. Picking the root pair because it is the only
// same-folder match puts the wings up by the head on every job and direction.
func TestGarmentPrefersPerJobAct(t *testing.T) {
	e := newEngine(t)

	const (
		garment = 61 // wing_of_angel_move
		job     = 1  // swordman, one of the many jobs with no per-job spr
	)
	perJob := "로브/wing_of_angel_move/남/검사_남"
	root := "로브/wing_of_angel_move/wing_of_angel_move"

	// The layout this test is about: per-job act with no per-job spr, next to a
	// complete root pair. Skip rather than fail if the client ever reships it.
	if !e.mgr.ExistsAct(perJob) || e.mgr.ExistsSpr(perJob) || !e.mgr.ExistsAct(root) || !e.mgr.ExistsSpr(root) {
		t.Skip("wing_of_angel_move no longer has a per-job act over a root-only pair")
	}

	req := baseReq()
	req.Job = job
	req.Garment = garment
	// Through the plan, so this still exercises the real candidate ordering —
	// BuildPlan does the existence filtering, loadGarment picks the first that
	// parses.
	g := e.loadGarment(e.Plan(req).Garment)
	if g == nil {
		t.Fatal("garment 61 did not resolve")
	}

	wantAct, err := e.mgr.Act(perJob)
	if err != nil {
		t.Fatalf("load per-job act: %v", err)
	}
	gotY := g.Act.Sprites(0, 0)[0].Y
	if wantY := wantAct.Sprites(0, 0)[0].Y; gotY != wantY {
		rootAct, _ := e.mgr.Act(root)
		t.Errorf("garment act frame (0,0) Y = %d, want %d (per-job act); the root act is at Y=%d",
			gotY, wantY, rootAct.Sprites(0, 0)[0].Y)
	}
}

// A "hat effect" costume ships an accessory sprite that is deliberately blank —
// every .act layer tinted alpha 0 — and puts its real visual in a separate
// looping sprite the client's hat-effect table plays at the character's head.
// The client ships exactly one today: view 1500, item 31089 [Visual] Fúria dos
// Shuras (아이템/c홍염의폭렬파동_이펙트). Rendering only the accessory produces an
// image byte-identical to wearing nothing at all, which is what this used to do.
func TestHatEffectDrawsBlankAccessory(t *testing.T) {
	e := newEngine(t)

	const view = 1500
	fx := e.res.HatEffectSprite(view)
	if !e.mgr.ExistsAct(fx) || !e.mgr.ExistsSpr(fx) {
		t.Skipf("hat-effect sprite %q not extracted", fx)
	}
	// The premise: the accessory itself draws nothing (alpha-0 layers only).
	acc, err := e.mgr.Act(e.res.HeadgearSprite(view, rotype.Male))
	if err != nil {
		t.Fatalf("load accessory act: %v", err)
	}
	for _, layer := range acc.Sprites(0, 0) {
		if layer.Tint.A != 0 {
			t.Fatalf("accessory for view %d is not blank any more (layer alpha %d)", view, layer.Tint.A)
		}
	}

	bare := baseReq()
	bare.Frame = 0
	worn := bare
	worn.Headgear = []uint32{view}

	bareRes, err := e.Render(bare)
	if err != nil {
		t.Fatalf("render bare: %v", err)
	}
	wornRes, err := e.Render(worn)
	if err != nil {
		t.Fatalf("render worn: %v", err)
	}
	if framesEqual(bareRes.Frames[0], wornRes.Frames[0]) {
		t.Error("wearing the hat effect changed nothing — the effect sprite was not composited")
	}
	// The effect is wider and taller than the character it swirls around, so it
	// grows the still's bounding box in both axes.
	if wornRes.Frames[0].Width <= bareRes.Frames[0].Width || wornRes.Frames[0].Height <= bareRes.Frames[0].Height {
		t.Errorf("worn still is %dx%d, not larger than the bare %dx%d",
			wornRes.Frames[0].Width, wornRes.Frames[0].Height, bareRes.Frames[0].Width, bareRes.Frames[0].Height)
	}

	// The effect has its own, longer timeline (27 frames against the body's 3),
	// and it is played straight through rather than sliced into head directions.
	anim := worn
	anim.Frame = -1
	animRes, err := e.Render(anim)
	if err != nil {
		t.Fatalf("render animation: %v", err)
	}
	fxAct, err := e.mgr.Act(fx)
	if err != nil {
		t.Fatalf("load effect act: %v", err)
	}
	if want := fxAct.NumberOfFrames(0); len(animRes.Frames) != want {
		t.Errorf("animation has %d frames, want the effect's %d", len(animRes.Frames), want)
	}
}

// The effect sprite has a single action and no per-direction frames — the client
// plays a hat effect the same way whatever the character is doing or facing — so
// it has to be pinned to action 0 rather than indexed by the request's action.
// Indexing it draws nothing at all for every action but stand-facing-south.
func TestHatEffectDrawsInEveryAction(t *testing.T) {
	e := newEngine(t)

	const view = 1500
	if fx := e.res.HatEffectSprite(view); !e.mgr.ExistsAct(fx) || !e.mgr.ExistsSpr(fx) {
		t.Skipf("hat-effect sprite %q not extracted", fx)
	}

	// Stand facing each direction, walk, sit, attack — and a female body, since
	// the effect sprite is one genderless file.
	for _, c := range []struct {
		name   string
		action uint
		gender rotype.Gender
	}{
		{"stand south", 0, rotype.Male},
		{"stand west", 3, rotype.Male},
		{"stand north", 4, rotype.Male},
		{"walk south", 8, rotype.Male},
		{"walk east", 8 + 7, rotype.Male},
		{"sit", 16, rotype.Male},
		{"attack", 40, rotype.Male},
		{"stand female", 0, rotype.Female},
	} {
		t.Run(c.name, func(t *testing.T) {
			req := baseReq()
			req.Frame = 0
			req.Action = c.action
			req.Gender = c.gender

			bare, err := e.Render(req)
			if err != nil {
				t.Fatalf("render bare: %v", err)
			}
			req.Headgear = []uint32{view}
			worn, err := e.Render(req)
			if err != nil {
				t.Fatalf("render worn: %v", err)
			}
			if framesEqual(bare.Frames[0], worn.Frames[0]) {
				t.Error("the hat effect drew nothing")
			}
		})
	}
}

// The hat effect follows the headgear id, not the character: a headgear with no
// effect sprite beside it leaves the render untouched.
func TestHatEffectOnlyForItsOwnHeadgear(t *testing.T) {
	e := newEngine(t)
	req := baseReq()
	req.Headgear = []uint32{1} // goggles
	p := e.Plan(req)
	if p.HatEffect[0] != "" {
		t.Errorf("headgear 1 (goggles) planned a hat effect: %q", p.HatEffect[0])
	}
	if got := e.loadHatEffect(p.HatEffect[0]); got != nil {
		t.Errorf("headgear 1 (goggles) grew a hat effect: %v", got.Act)
	}
}
