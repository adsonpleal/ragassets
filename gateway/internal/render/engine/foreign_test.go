package engine

import (
	"path/filepath"
	"testing"

	"github.com/ragassets/gateway/internal/render/resolve"
)

// foreignView stands in for a costume that exists on another official server
// and not here. It must be a view id this client's tables do not know — the
// test asserts that, so that a client update which starts using the id fails
// here rather than quietly turning this into a test of nothing.
const foreignView = 60001

func foreignReq() Request {
	r := baseReq()
	r.Frame = 0 // one still, so the comparison is pixel-for-pixel
	return r
}

// A foreign costume is addressed by name, not by id, and this is why: asking
// this client for an id it does not have is not an error. The renderer draws
// the character without the hat and returns a perfectly good PNG — a 200, the
// right size, the right character, no costume. Nothing downstream can tell that
// from a request that asked for no costume at all, which is what made the
// failure survive all the way to a browser.
func TestForeignViewIDAloneDrawsNothing(t *testing.T) {
	e := New(filepath.Join("testdata", "fixtures"), resolve.DefaultTables())

	if n := resolve.DefaultTables().AccName(foreignView); n != "" {
		t.Fatalf("view %d now means %q in this client — pick another id for this test", foreignView, n)
	}

	bare, err := e.Render(foreignReq())
	if err != nil {
		t.Fatalf("bare render: %v", err)
	}
	req := foreignReq()
	req.Headgear = []uint32{foreignView}
	withID, err := e.Render(req)
	if err != nil {
		t.Fatalf("render with an unknown view: %v", err)
	}
	if !framesEqual(bare.Frames[0], withID.Frames[0]) {
		t.Fatal("an unknown view id drew something — this test no longer describes the failure it guards")
	}
}

// The fix: the caller names the sprite, and the renderer draws it.
//
// This is a regression test for a real mistake. The first version of
// RenderWithTables handed the overridden names to BuildPlan only, and left the
// Engine's own resolver in place for the draw. The plan found the foreign hat,
// the draw asked the old tables for its name, got "", and skipped it — so the
// output was still byte-identical to the bare render, through a code path that
// looked like it was working. Comparing against `bare` is the whole point:
// asserting on the status code, or that a PNG came back, or that it parses,
// all pass while nothing is drawn.
func TestForeignSpriteNameDraws(t *testing.T) {
	e := New(filepath.Join("testdata", "fixtures"), resolve.DefaultTables())

	bare, err := e.Render(foreignReq())
	if err != nil {
		t.Fatalf("bare render: %v", err)
	}

	req := foreignReq()
	req.Headgear = []uint32{foreignView}
	// "_고글" (goggles) is in the fixture pack. Here it plays the part of a
	// sprite that only another server's client ships.
	tables := resolve.SpriteNames{
		Tables: resolve.DefaultTables(),
		Acc:    map[uint32]string{foreignView: "_고글"},
	}
	drawn, err := e.RenderWithTables(req, tables)
	if err != nil {
		t.Fatalf("render with an overridden name: %v", err)
	}

	if framesEqual(bare.Frames[0], drawn.Frames[0]) {
		t.Fatal("naming the sprite changed nothing — the hat was not drawn")
	}
	if got, want := opaqueCount(drawn.Frames[0]), opaqueCount(bare.Frames[0]); got <= want {
		t.Errorf("drawing a hat should add pixels: %d opaque with it, %d without", got, want)
	}
}

// The override must not leak into the next request. The Engine is shared across
// every request the process serves, so a copy that wrote back would mean one
// visitor's foreign costume appearing on another visitor's character.
func TestForeignOverrideDoesNotLeak(t *testing.T) {
	e := New(filepath.Join("testdata", "fixtures"), resolve.DefaultTables())

	before, err := e.Render(foreignReq())
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	req := foreignReq()
	req.Headgear = []uint32{foreignView}
	if _, err := e.RenderWithTables(req, resolve.SpriteNames{
		Tables: resolve.DefaultTables(),
		Acc:    map[uint32]string{foreignView: "_고글"},
	}); err != nil {
		t.Fatalf("foreign render: %v", err)
	}
	after, err := e.Render(foreignReq())
	if err != nil {
		t.Fatalf("render after: %v", err)
	}
	if !framesEqual(before.Frames[0], after.Frames[0]) {
		t.Error("a foreign render changed what the next ordinary render produced")
	}

	// And nil tables is the ordinary path, unchanged.
	plain, err := e.RenderWithTables(foreignReq(), nil)
	if err != nil {
		t.Fatalf("RenderWithTables(nil): %v", err)
	}
	if !framesEqual(before.Frames[0], plain.Frames[0]) {
		t.Error("RenderWithTables(nil) should render exactly as Render does")
	}
}
