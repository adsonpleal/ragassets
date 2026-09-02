package skin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// data/skin_table.json is the reviewable source; table_baked_gen.go is the bake.
// This test re-reads the JSON and checks the two agree, so a regenerated table
// that was never re-baked fails here instead of silently serving stale data.
//
// Using encoding/json in the test is deliberate — it is the production path that
// must stay free of it. TestTableInvariants covers the value-range checks that
// the old init() performed before it was replaced by generated code.

type jsonSkinTable struct {
	Version int                     `json:"version"`
	Base    []string                `json:"base"`
	Body    map[string][]int        `json:"body"`
	Head    map[string]jsonSkinHead `json:"head"`
}

type jsonSkinHead struct {
	Skin []int              `json:"skin"`
	Px   map[string][][]int `json:"px"`
}

func readSkinJSON(t *testing.T) jsonSkinTable {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("data", "skin_table.json"))
	if err != nil {
		t.Fatalf("read skin_table.json: %v", err)
	}
	var out jsonSkinTable
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("parse skin_table.json: %v", err)
	}
	return out
}

func TestBakedSkinTableMatchesJSON(t *testing.T) {
	src := readSkinJSON(t)

	if src.Version != TableVersion {
		t.Fatalf("skin_table.json version %d, TableVersion %d", src.Version, TableVersion)
	}

	bodies, heads := Counts()
	if bodies != len(src.Body) {
		t.Errorf("baked %d bodies, JSON has %d — run `go generate ./...`", bodies, len(src.Body))
	}
	if heads != len(src.Head) {
		t.Errorf("baked %d heads, JSON has %d — run `go generate ./...`", heads, len(src.Head))
	}

	for path, flat := range src.Body {
		got, ok := Body(path)
		if !ok {
			t.Errorf("body %q missing from baked table", path)
			continue
		}
		want := decodeSlots(flat)
		if len(got) != len(want) {
			t.Errorf("body %q: baked %d slots, JSON has %d", path, len(got), len(want))
			continue
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("body %q slot %d: baked %+v, JSON %+v", path, i, got[i], want[i])
			}
		}
	}

	for path, h := range src.Head {
		got, ok := Head(path)
		if !ok {
			t.Errorf("head %q missing from baked table", path)
			continue
		}
		want := decodeSlots(h.Skin)
		if len(got.Skin) != len(want) {
			t.Errorf("head %q: baked %d skin slots, JSON has %d", path, len(got.Skin), len(want))
		} else {
			for i := range want {
				if got.Skin[i] != want[i] {
					t.Errorf("head %q skin %d: baked %+v, JSON %+v", path, i, got.Skin[i], want[i])
				}
			}
		}

		if len(got.Px) != len(h.Px) {
			t.Errorf("head %q: baked %d px images, JSON has %d", path, len(got.Px), len(h.Px))
			continue
		}
		for imgStr, runs := range h.Px {
			img, err := strconv.Atoi(imgStr)
			if err != nil {
				t.Errorf("head %q: bad image key %q", path, imgStr)
				continue
			}
			gotRuns := got.Px[img]
			if len(gotRuns) != len(runs) {
				t.Errorf("head %q image %d: baked %d runs, JSON has %d", path, img, len(gotRuns), len(runs))
				continue
			}
			for i, run := range runs {
				if len(run) < 3 {
					t.Errorf("head %q image %d run %d: JSON run needs srcIndex, pos and >= 1 offset", path, img, i)
					continue
				}
				g := gotRuns[i]
				if g.SrcIndex != run[0] {
					t.Errorf("head %q image %d run %d: SrcIndex baked %d, JSON %d", path, img, i, g.SrcIndex, run[0])
				}
				if wantPos := float64(run[1]) / 1000; g.Pos != wantPos {
					t.Errorf("head %q image %d run %d: Pos baked %v, JSON %v", path, img, i, g.Pos, wantPos)
				}
				if len(g.Offsets) != len(run)-2 {
					t.Errorf("head %q image %d run %d: baked %d offsets, JSON %d", path, img, i, len(g.Offsets), len(run)-2)
					continue
				}
				for j, o := range run[2:] {
					if g.Offsets[j] != int32(o) {
						t.Errorf("head %q image %d run %d offset %d: baked %d, JSON %d", path, img, i, j, g.Offsets[j], o)
					}
				}
			}
		}
	}
}

// decodeSlots mirrors the flat index,slot pair encoding used in the JSON.
func decodeSlots(flat []int) []SlotIndex {
	out := make([]SlotIndex, 0, len(flat)/2)
	for i := 0; i+1 < len(flat); i += 2 {
		out = append(out, SlotIndex{Index: flat[i], Slot: flat[i+1]})
	}
	return out
}
