package resource

import (
	"errors"
	"io/fs"
	"testing"
)

func TestOverlaySourcePrefersTheFrontTree(t *testing.T) {
	// The case this exists for: the same key names different art in two
	// clients. The front tree must win, and the back tree must still answer
	// everything the front one does not have.
	front := MapSource{"sprite/악세사리/남/남_두건.spr": []byte("foreign")}
	back := MapSource{
		"sprite/악세사리/남/남_두건.spr":   []byte("latam"),
		"sprite/인간족/몸통/남/검사_남.spr": []byte("body"),
	}
	o := OverlaySource{front, back}

	if b, err := o.Get("sprite/악세사리/남/남_두건.spr"); err != nil || string(b) != "foreign" {
		t.Errorf("shared key: got %q, %v — want the front tree's bytes", b, err)
	}
	if b, err := o.Get("sprite/인간족/몸통/남/검사_남.spr"); err != nil || string(b) != "body" {
		t.Errorf("back-only key: got %q, %v — want the back tree's bytes", b, err)
	}
}

func TestOverlaySourceMissIsNotExist(t *testing.T) {
	// A miss has to stay loud and stay fs.ErrNotExist: the Manager caches it as
	// a negative result, and a silent empty read would render as a hole.
	o := OverlaySource{MapSource{}, MapSource{}}
	_, err := o.Get("sprite/nope.spr")
	if err == nil {
		t.Fatal("a key in neither tree must error")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("error should wrap fs.ErrNotExist, got %v", err)
	}
}

func TestOverlaySourceEmptyIsNotExist(t *testing.T) {
	_, err := OverlaySource{}.Get("anything")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("an overlay with no sources should report not-exist, got %v", err)
	}
}

type hasOnly map[string]bool

func (h hasOnly) Has(k string) bool { return h[k] }

func TestOverlayExistenceIsTheUnion(t *testing.T) {
	// BuildPlan probes through Existence and then reads through Source, so the
	// two must agree on what is there or a plan names a key the render cannot
	// read.
	o := OverlayExistence{hasOnly{"a": true}, hasOnly{"b": true}}
	for k, want := range map[string]bool{"a": true, "b": true, "c": false} {
		if got := o.Has(k); got != want {
			t.Errorf("Has(%q) = %v, want %v", k, got, want)
		}
	}
	if (OverlayExistence{}).Has("a") {
		t.Error("an empty overlay has nothing")
	}
}
