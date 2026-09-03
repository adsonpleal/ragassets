package engine

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ragassets/gateway/internal/render/resolve"
	"github.com/ragassets/gateway/internal/render/resource"
	"github.com/ragassets/gateway/internal/render/rotype"
)

// manifestForTree bakes an existence manifest from the real resource tree, the
// same way cmd/gen-manifest does.
func manifestForTree(t *testing.T, root string) *resource.Manifest {
	t.Helper()
	var keys []string
	for folder, exts := range map[string][]string{
		"sprite":  {".spr", ".act"},
		"palette": {".pal"},
		"imf":     {".imf"},
	} {
		dir := filepath.Join(root, "data", folder)
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			lower := strings.ToLower(p)
			for _, e := range exts {
				if strings.HasSuffix(lower, e) {
					rel, relErr := filepath.Rel(dir, p)
					if relErr != nil {
						return relErr
					}
					keys = append(keys, folder+"/"+filepath.ToSlash(rel))
					return nil
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	m, collisions, err := resource.BuildManifest(keys)
	if err != nil {
		t.Fatalf("BuildManifest: %v (%v)", err, collisions)
	}
	return m
}

// TestPlanMatchesUnderManifest is the acceptance test for cmd/gen-manifest: a
// plan built against the baked manifest must be identical to one built against
// the filesystem, across a wide spread of requests.
//
// This is the property the whole thing rests on. BuildPlan's probes are what
// choose the body sprite, which garment candidates survive, and whether a
// headgear has an effect — so a manifest that disagreed anywhere would not fail
// loudly, it would render a different character.
func TestPlanMatchesUnderManifest(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "resources")
	if _, err := os.Stat(filepath.Join(root, "data")); err != nil {
		t.Skipf("resources not present: %v", err)
	}

	tables := resolve.DefaultTables()
	res := resolve.New(tables)
	fsx := resource.FSExistence{Root: root}
	man := manifestForTree(t, root)

	var reqs []Request
	// The golden cases, so the comparison covers what the pixel tests cover.
	for _, c := range goldenCases() {
		reqs = append(reqs, c.req)
	}
	// A spread over the dimensions that actually drive probes: garments walk the
	// candidate list, outfits gate the alternative body, headgears gate the hat
	// effect. Jobs span 1st through 4th class plus non-players.
	jobs := []uint32{1, 2, 4, 7, 12, 4008, 4060, 4211, 4252, 4255, 1002, 1188, 2100}
	garments := []uint32{0, 1, 61, 245, 300, 999, 1300}
	for _, job := range jobs {
		for _, garment := range garments {
			for _, gender := range []rotype.Gender{rotype.Male, rotype.Female} {
				r := baseReq()
				r.Job = job
				r.Gender = gender
				r.Garment = garment
				r.Frame = 0
				reqs = append(reqs, r)
			}
		}
	}
	// Outfits and headgears, which reach the other two probe sites. The ids here
	// are the ones that actually hit in this client — headgear 1500 is the only
	// accessory with a hat-effect sprite (아이템/c홍염의폭렬파동_이펙트), and the
	// costume bodies are 4th-class, so 4255/4256 with outfit 1 are what exercise
	// the alternative-body probe. Generic ids miss all three and leave the test
	// passing on nothing, which is what the coverage assertions below guard.
	for _, job := range []uint32{1, 4255, 4256} {
		for _, outfit := range []uint32{0, 1, 2, 3, 4, 9} {
			for _, hg := range [][]uint32{nil, {1}, {1500}, {2, 3}, {1500, 1, 2}, {99999}} {
				r := baseReq()
				r.Frame = 0
				r.Job = job
				r.Outfit = outfit
				r.Headgear = hg
				reqs = append(reqs, r)
			}
		}
	}

	var probed, sawCandidates, sawFallback, sawHatEffect, sawOutfit int
	for _, req := range reqs {
		want := BuildPlan(req, res, fsx)
		got := BuildPlan(req, res, man)

		if want.Body != got.Body || want.UseOutfit != got.UseOutfit {
			t.Errorf("job=%d gender=%d outfit=%d: body (%q,%v) vs manifest (%q,%v)",
				req.Job, req.Gender, req.Outfit, want.Body, want.UseOutfit, got.Body, got.UseOutfit)
		}
		if !reflect.DeepEqual(want.HatEffect, got.HatEffect) {
			t.Errorf("job=%d headgear=%v: hat effect %v vs manifest %v",
				req.Job, req.Headgear, want.HatEffect, got.HatEffect)
		}
		if !reflect.DeepEqual(want.Garment.Candidates, got.Garment.Candidates) {
			t.Errorf("job=%d garment=%d: %d candidates vs manifest %d",
				req.Job, req.Garment, len(want.Garment.Candidates), len(got.Garment.Candidates))
		}
		if want.Garment.FallbackAct != got.Garment.FallbackAct ||
			want.Garment.FallbackSpr != got.Garment.FallbackSpr {
			t.Errorf("job=%d garment=%d: fallback (%q,%q) vs manifest (%q,%q)",
				req.Job, req.Garment,
				want.Garment.FallbackAct, want.Garment.FallbackSpr,
				got.Garment.FallbackAct, got.Garment.FallbackSpr)
		}
		if !reflect.DeepEqual(want.Keys, got.Keys) {
			t.Errorf("job=%d garment=%d outfit=%d: key set differs (%d vs %d)",
				req.Job, req.Garment, req.Outfit, len(want.Keys), len(got.Keys))
		}
		probed += len(want.Keys)
		if len(want.Garment.Candidates) > 0 {
			sawCandidates++
		}
		if want.Garment.FallbackAct != "" {
			sawFallback++
		}
		if want.HatEffect[0] != "" || want.HatEffect[1] != "" || want.HatEffect[2] != "" {
			sawHatEffect++
		}
		if want.UseOutfit {
			sawOutfit++
		}
	}

	// Every probe site must be genuinely reached. Without this the comparison
	// could agree on requests that never probe anything — the manifest would be
	// unverified for exactly the decisions it exists to make, and the test would
	// still pass.
	for _, c := range []struct {
		name string
		n    int
	}{
		{"garment candidates", sawCandidates},
		{"garment fallback", sawFallback},
		{"hat effect", sawHatEffect},
		{"alternative outfit", sawOutfit},
	} {
		if c.n == 0 {
			t.Errorf("no request reached the %s probe — the comparison proves nothing about it", c.name)
		}
	}

	t.Logf("%d requests planned both ways, %d keys resolved identically", len(reqs), probed)
	t.Logf("probe coverage: %d candidates, %d fallback, %d hat effect, %d outfit",
		sawCandidates, sawFallback, sawHatEffect, sawOutfit)
}
