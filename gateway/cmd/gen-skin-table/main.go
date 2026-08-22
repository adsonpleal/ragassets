// gen-skin-table bakes internal/render/skin/data/skin_table.json: for every
// player body and head sprite, which palette indices hold the human skin ramp,
// and — for heads — which individual pixels must be repainted because their
// palette index is shared between hair and the face's specular highlight.
//
// Why a bake and not a runtime rule:
//
//   - The skin ramp is NOT at a fixed palette position in body sprites. The
//     Wanderer's default body has it at 48-55 but her costume_1 body has it at
//     43-50, and 195 of 364 body dye groups dye something inside 48-55. A
//     hardcoded range recolours clothing and misses skin.
//   - Roughly 87% of head sprites use one palette index for two different things:
//     a hair highlight and the face's specular highlight. No palette swap can
//     separate them, so those pixels are identified here and repainted at render
//     time.
//
// Detection is deliberately evidence-based rather than hardcoded: skin indices are
// found by matching the sprite's own palette against the canonical ramp and then
// proving those indices never move across the sprite's own dye palettes.
//
// This is a manual maintenance step (like cmd/gen-resolver): re-run it when the
// client's sprites change. The committed JSON is the source of truth for the
// running gateway.
//
// Usage:
//
//	go run ./cmd/gen-skin-table -resources ../resources
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/resource"
	"github.com/ragassets/gateway/internal/render/roformat"
	"github.com/ragassets/gateway/internal/render/rotype"
	"github.com/ragassets/gateway/internal/render/skin"
)

const (
	humanRace = "인간족"
	bodyDir   = "몸통"
	headDir   = "머리통"

	// maxDyeID caps the per-sprite dye scan; the real maximum is 8-9.
	maxDyeID = 40
	// maxHeadID caps the head-id scan used to find each head's dye palettes.
	maxHeadID = 128
)

type config struct {
	resources     string
	out           string
	maskThreshold float64
	maxRunSide    int
	sheets        string
	verbose       bool
}

func main() {
	log.SetFlags(0)
	var cfg config
	flag.StringVar(&cfg.resources, "resources", "../resources", "path to the extracted resources/ directory")
	flag.StringVar(&cfg.out, "out", "", "output JSON path (default internal/render/skin/data/skin_table.json)")
	flag.Float64Var(&cfg.maskThreshold, "mask-threshold", 0.30, "fraction of heads that must agree a pixel is skin for it to join the canonical face mask")
	flag.IntVar(&cfg.maxRunSide, "max-run-side", 6, "largest bounding-box side a pixel run may have and still count as a face highlight")
	flag.StringVar(&cfg.sheets, "sheets", "", "directory to write per-gender review contact sheets into (optional)")
	flag.BoolVar(&cfg.verbose, "v", false, "list every sprite decision")
	flag.Parse()

	if cfg.out == "" {
		cfg.out = filepath.Join("internal", "render", "skin", "data", "skin_table.json")
	}
	if err := run(cfg); err != nil {
		log.Fatalf("gen-skin-table: %v", err)
	}
}

func run(cfg config) error {
	mgr := resource.NewManager(cfg.resources)
	res := resolve.New(resolve.DefaultTables())

	dyes, err := buildDyeIndex(cfg, res)
	if err != nil {
		return err
	}
	log.Printf("dye index: %d sprites mapped to their own palette sets", len(dyes))

	out := table{
		Version: skin.TableVersion,
		Base:    baseHex(),
		Body:    map[string][]int{},
		Head:    map[string]headOut{},
	}

	bodyStats, err := bakeBodies(cfg, mgr, dyes, out.Body)
	if err != nil {
		return err
	}
	headStats, err := bakeHeads(cfg, mgr, dyes, out.Head)
	if err != nil {
		return err
	}

	if err := writeTable(cfg.out, out); err != nil {
		return err
	}

	log.Printf("bodies: %d with skin, %d without (suited/no skin); %d carry skin at more than one palette position, %d needed the adjacency test",
		bodyStats.matched, bodyStats.noSkin, bodyStats.multi, bodyStats.loose)
	log.Printf("heads:  %d baked, %d with a non-canonical layout", headStats.matched, headStats.nonCanonical)
	log.Printf("face-lighting pixels: %d over %d runs (%d heads affected)",
		headStats.pixels, headStats.runs, headStats.headsWithRuns)
	log.Printf("rule contribution: local-only %d px, mask-only %d px, both %d px",
		headStats.onlyA, headStats.onlyB, headStats.both)
	log.Printf("wrote %s", cfg.out)

	// A tripwire, not a spec: the reviewed bake had ~1.7k override pixels. An
	// order-of-magnitude move means detection changed and the visual review is
	// stale, so fail rather than silently shipping it.
	//
	// Counted per SPR image, once each. Several directions share one image (5-7
	// mirror 1-3), so a per-direction tally roughly doubles this without a single
	// extra pixel being painted.
	const reviewed = 1750
	if headStats.pixels*3 < reviewed || headStats.pixels > reviewed*3 {
		return fmt.Errorf("face-lighting pixel count %d is far from the reviewed %d; "+
			"re-review the -sheets output and update this bound if the change is intended",
			headStats.pixels, reviewed)
	}
	return nil
}

// ---- output shape -------------------------------------------------------

type table struct {
	Version int                `json:"version"`
	Base    []string           `json:"base"`
	Body    map[string][]int   `json:"body"` // flat index,slot pairs
	Head    map[string]headOut `json:"head"`
}

type headOut struct {
	Skin []int              `json:"skin"` // flat index,slot pairs
	Px   map[string][][]int `json:"px"`
}

func baseHex() []string {
	out := make([]string, 0, len(skin.BaseRamp))
	for _, c := range skin.BaseRamp {
		out = append(out, fmt.Sprintf("%02x%02x%02x", c.R, c.G, c.B))
	}
	return out
}

func writeTable(path string, t table) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(t) // minified, per the repo's served-table convention
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

// ---- dye index ----------------------------------------------------------

// buildDyeIndex maps each player sprite name to the dye palette names that apply
// to it. The mapping cannot be derived from the path: palette base names come
// from job_pal_names.txt while sprite names come from job_names.txt, and the two
// differ. So it is built by driving the resolver over every player job.
func buildDyeIndex(cfg config, res *resolve.Resolver) (map[string][]string, error) {
	out := map[string][]string{}
	add := func(sprite string, pal func(int) string) {
		if sprite == "" {
			return
		}
		if _, seen := out[sprite]; seen {
			return
		}
		var list []string
		for id := 0; id < maxDyeID; id++ {
			name := pal(id)
			if name == "" {
				break
			}
			if !fileExists(cfg.resources, "palette", name, "pal") {
				break
			}
			list = append(list, name)
		}
		if list != nil {
			out[sprite] = list
		}
	}

	genders := []rotype.Gender{rotype.Female, rotype.Male}
	mados := []rotype.MadogearType{rotype.MadogearRobot, rotype.MadogearSuit}

	for _, job := range playerJobIDs() {
		if resolve.IsDoram(job) {
			continue
		}
		for _, g := range genders {
			for _, mado := range mados {
				j, gg, m := job, g, mado
				add(res.PlayerBodySprite(j, gg, m), func(id int) string {
					return res.BodyPalette(j, id, gg, m)
				})
				for costume := uint32(1); costume <= 4; costume++ {
					c := costume
					add(res.PlayerBodyAltSprite(j, gg, c, m), func(id int) string {
						return res.BodyAltPalette(j, id, gg, c, m)
					})
				}
			}
			for head := uint32(1); head <= maxHeadID; head++ {
				h := head
				gg := g
				j := job
				add(res.PlayerHeadSprite(j, h, gg), func(id int) string {
					return res.HeadPalette(j, h, id, gg)
				})
			}
		}
	}
	return out, nil
}

// playerJobIDs lists the job ids resolve.IsPlayer accepts that can actually index
// the name tables (ids above 4000 have advancedJobIndex subtracted).
func playerJobIDs() []uint32 {
	var out []uint32
	for id := uint32(0); id < 45; id++ {
		out = append(out, id)
	}
	for id := uint32(4001); id <= 4400; id++ {
		out = append(out, id)
	}
	return out
}

func fileExists(root, folder, name, ext string) bool {
	p := filepath.Join(root, "data", folder, filepath.FromSlash(name)+"."+ext)
	_, err := os.Stat(p)
	return err == nil
}

// walkSprites lists resolved sprite names (forward-slashed, no extension) under a
// resources subtree.
func walkSprites(root, sub string) ([]string, error) {
	base := filepath.Join(root, "data", "sprite", filepath.FromSlash(sub))
	var out []string
	err := filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.EqualFold(filepath.Ext(p), ".spr") {
			return nil
		}
		rel, err := filepath.Rel(filepath.Join(root, "data", "sprite"), p)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(strings.TrimSuffix(rel, filepath.Ext(rel))))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// loadPair loads a sprite's SPR and ACT together.
func loadPair(mgr *resource.Manager, name string) (*roformat.Spr, *roformat.Act, error) {
	spr, err := mgr.Spr(name)
	if err != nil {
		return nil, nil, err
	}
	act, err := mgr.Act(name)
	if err != nil {
		return spr, nil, err
	}
	return spr, act, nil
}
