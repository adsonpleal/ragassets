package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/sprite"
)

func TestEquipmentOrderExample(t *testing.T) {
	e := New("", resolve.DefaultTables())
	// Hat, glasses, scarf, wings; reverse the input to catch positional sorting.
	for _, ids := range [][]uint32{{1053, 2399, 2530}, {2530, 2399, 1053}} {
		for d := 0; d < 8; d++ {
			req := Request{Headgear: ids, Garment: 12, Action: uint(d)}
			sprites := []*sprite.Sprite{{Type: sprite.TypePlayerBody}, {Type: sprite.TypePlayerHead}}
			for i, id := range ids {
				sprites = append(sprites, &sprite.Sprite{Type: sprite.TypeAccessory, TypeOrder: i, AccessoryID: id})
			}
			wings := &sprite.Sprite{Type: sprite.TypeGarment}
			sprites = append(sprites, wings)
			index := make([]int, len(sprites))
			e.sortDelegate(sprites, req, nil)(index, 0, 1)
			for _, s := range sprites {
				if s.AccessoryID == 2530 && d >= 2 && d <= 6 && wings.ZIndex <= s.ZIndex {
					t.Fatalf("direction %d: wings %d must cover scarf %d", d, wings.ZIndex, s.ZIndex)
				}
			}
			if (d == 0 || d == 1 || d == 7) && wings.ZIndex >= sprites[0].ZIndex {
				t.Fatalf("front-facing wings must remain behind body")
			}
		}
	}
}

// Exercise every client override in every direction, both with another accessory
// and a robe. This covers actual render sorting, not just JSON lookup parity.
func TestEquipmentOrderAllClientOverrides(t *testing.T) {
	var rows map[string]struct {
		Default *int           `json:"default"`
		Dir     map[string]int `json:"dir"`
	}
	b, err := os.ReadFile(filepath.Join("..", "resolve", "data", "layer_priority.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &rows); err != nil {
		t.Fatal(err)
	}
	e := New("", resolve.DefaultTables())
	for id := range rows {
		var view uint32
		if _, err := fmt.Sscan(id, &view); err != nil {
			t.Fatal(err)
		}
		for d := 0; d < 8; d++ {
			p, ok := e.tables.HeadgearPriority(view, d)
			if !ok {
				continue
			}
			acc := &sprite.Sprite{Type: sprite.TypeAccessory, AccessoryID: view, TypeOrder: 0}
			peer := &sprite.Sprite{Type: sprite.TypeAccessory, AccessoryID: 999999, TypeOrder: 2}
			robe := &sprite.Sprite{Type: sprite.TypeGarment}
			body := &sprite.Sprite{Type: sprite.TypePlayerBody}
			sprites := []*sprite.Sprite{body, acc, peer, robe}
			index := make([]int, len(sprites))
			e.sortDelegate(sprites, Request{Garment: 12, Action: uint(d)}, nil)(index, 0, 1)
			if p < 0 {
				if acc.ZIndex >= body.ZIndex {
					t.Errorf("view %d dir %d: rear accessory crossed body", view, d)
				}
			} else {
				if acc.ZIndex <= body.ZIndex {
					t.Errorf("view %d dir %d: front accessory crossed body", view, d)
				}
				if p < 300 && acc.ZIndex >= peer.ZIndex || p > 300 && acc.ZIndex <= peer.ZIndex {
					t.Errorf("view %d dir %d: priority %d ordered incorrectly against lower slot", view, d, p)
				}
				if d >= 2 && d <= 6 && (p < 400 && acc.ZIndex >= robe.ZIndex || p > 400 && acc.ZIndex <= robe.ZIndex) {
					t.Errorf("view %d dir %d: priority %d ordered incorrectly against robe", view, d, p)
				}
			}
		}
	}
}

// Equipment positions must be absolute. Adding an unrelated accessory cannot
// move a cape across the head, and all robes use the client's default of 400.
func TestEquipmentOrderIndependentOfOtherGear(t *testing.T) {
	e := New("", resolve.DefaultTables())
	for d := 0; d < 8; d++ {
		for _, garment := range []uint32{12, 245} {
			var robeZ, headZ int
			for count := 0; count <= 3; count++ {
				body := &sprite.Sprite{Type: sprite.TypePlayerBody}
				head := &sprite.Sprite{Type: sprite.TypePlayerHead}
				robe := &sprite.Sprite{Type: sprite.TypeGarment}
				ss := []*sprite.Sprite{body, head, robe}
				for i := 0; i < count; i++ {
					ss = append(ss, &sprite.Sprite{Type: sprite.TypeAccessory, TypeOrder: i, AccessoryID: 1053})
				}
				e.sortDelegate(ss, Request{Action: uint(d), Garment: garment}, nil)(make([]int, len(ss)), 0, 1)
				if count == 0 {
					robeZ, headZ = robe.ZIndex, head.ZIndex
				}
				if robe.ZIndex != robeZ || head.ZIndex != headZ {
					t.Fatalf("garment %d direction %d moved when another accessory was equipped", garment, d)
				}
				if d >= 2 && d <= 6 && robe.ZIndex <= head.ZIndex {
					t.Fatalf("back-facing robe %d must cover head and lower equipment", garment)
				}
			}
		}
	}
}

func TestEquipmentRidingExceptionsAndManualOverride(t *testing.T) {
	e := New("", resolve.DefaultTables())
	// Client-listed exception 1582 can hang below the collar without hiding behind
	// a mount; an explicit request override still takes precedence.
	for _, c := range []struct {
		id         uint32
		manual     bool
		wantBehind bool
	}{{1582, false, false}, {2095, false, true}, {1582, true, true}} {
		acc := &sprite.Sprite{Type: sprite.TypeAccessory, AccessoryID: c.id, MountOccluded: true}
		req := Request{}
		if c.manual {
			req.HeadgearBehind = []uint32{c.id}
		}
		if got := e.accessoryBehind(req, acc, 0); got != c.wantBehind {
			t.Errorf("view %d manual=%v: behind=%v, want %v", c.id, c.manual, got, c.wantBehind)
		}
	}
}

func TestEquipmentNegativePrioritiesAndStableTies(t *testing.T) {
	e := New("", resolve.DefaultTables())
	for d := 0; d < 8; d++ {
		// Two wigs with the same client priority must keep their input order.
		a := &sprite.Sprite{Type: sprite.TypeAccessory, AccessoryID: 1621, TypeOrder: 1}
		b := &sprite.Sprite{Type: sprite.TypeAccessory, AccessoryID: 1622, TypeOrder: 0}
		ss := []*sprite.Sprite{a, b}
		index := make([]int, 2)
		e.sortDelegate(ss, Request{Action: uint(d)}, nil)(index, 0, 1)
		if index[0] != 0 || index[1] != 1 || a.ZIndex != b.ZIndex {
			t.Fatalf("direction %d: equal priorities lost stable input order", d)
		}
	}
	// -300 sorts behind -100; both sit above the shadow and below the body.
	a := &sprite.Sprite{Type: sprite.TypeAccessory, AccessoryID: 2803, TypeOrder: 2}
	b := &sprite.Sprite{Type: sprite.TypeAccessory, AccessoryID: 2669, TypeOrder: 0}
	body := &sprite.Sprite{Type: sprite.TypePlayerBody}
	shadow := &sprite.Sprite{Type: sprite.TypeShadow}
	ss := []*sprite.Sprite{a, b, body, shadow}
	e.sortDelegate(ss, Request{}, nil)(make([]int, 4), 0, 1)
	if !(shadow.ZIndex < a.ZIndex && a.ZIndex < b.ZIndex && b.ZIndex < body.ZIndex) {
		t.Fatal("negative priorities did not retain their numeric order behind the body")
	}
}

// The reported URL requests an animation. Every paused frame must use the same
// corrected layers as that frame in the animation, including the body IMF.
func TestEquipmentExampleAnimationMatchesStills(t *testing.T) {
	e := New(filepath.Join("testdata", "fixtures"), resolve.DefaultTables())
	for _, c := range goldenCases() {
		if c.req.Job != 4306 {
			continue
		}
		req := c.req
		req.Frame = -1
		animation, err := e.Render(req)
		if err != nil {
			t.Fatal(err)
		}
		if len(animation.Frames) < 2 {
			t.Fatal("reported outfit should animate")
		}
		for f, want := range animation.Frames {
			req.Frame = f
			still, err := e.Render(req)
			if err != nil {
				t.Fatal(err)
			}
			if len(still.Frames) != 1 || !framesEqual(still.Frames[0], want) {
				t.Fatalf("direction %d frame %d: animation and still layers differ", req.Action, f)
			}
		}
	}
}
