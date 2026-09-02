package resolve

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// The generated tables_baked_gen.go and the committed data/*.json are two
// representations of the same thing, and only the JSON is human-reviewable. These
// tests re-read the JSON and check the baked data agrees, so a regenerated JSON
// that was never re-baked fails here rather than silently serving stale tables.
//
// Using encoding/json in the test is deliberate: it is the production path that
// must stay free of it, not the test binary.

type jsonTablesFile struct {
	AccName    map[string]string `json:"accname"`
	Robe       map[string]string `json:"robe"`
	RobeEng    map[string]string `json:"robeEng"`
	Weapon     map[string]string `json:"weapon"`
	RealWeapon map[string]uint32 `json:"realWeapon"`
	JobName    map[string]string `json:"jobName"`
	IsTopLayer map[string]bool   `json:"isTopLayer"`
}

type jsonLayerPriority struct {
	Default *int           `json:"default"`
	Dir     map[string]int `json:"dir"`
}

func readTestJSON(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("data", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

func TestBakedTablesMatchJSON(t *testing.T) {
	var src jsonTablesFile
	readTestJSON(t, "tables.json", &src)

	tbl := DefaultTables()

	check := func(label string, m map[string]string, get func(uint32) string) {
		t.Helper()
		for k, want := range m {
			id, err := strconv.ParseUint(k, 10, 32)
			if err != nil {
				continue
			}
			if got := get(uint32(id)); got != want {
				t.Errorf("%s(%d) = %q, JSON says %q — run `go generate ./...`", label, id, got, want)
			}
		}
	}

	check("AccName", src.AccName, tbl.AccName)
	check("JobName", src.JobName, tbl.JobName)
	check("WeaponName", src.Weapon, tbl.WeaponName)
	check("RobeSprName", src.Robe, func(id uint32) string { return tbl.RobeSprName(id, false) })
	check("RobeSprNameEng", src.RobeEng, func(id uint32) string { return tbl.RobeSprName(id, true) })

	for k, want := range src.RealWeapon {
		id, err := strconv.ParseUint(k, 10, 32)
		if err != nil {
			continue
		}
		if got := tbl.RealWeaponID(uint32(id)); got != want {
			t.Errorf("RealWeaponID(%d) = %d, JSON says %d", id, got, want)
		}
	}

	for k, want := range src.IsTopLayer {
		id, err := strconv.ParseUint(k, 10, 32)
		if err != nil {
			continue
		}
		if got := tbl.IsTopLayer(uint32(id)); got != want {
			t.Errorf("IsTopLayer(%d) = %v, JSON says %v", id, got, want)
		}
	}

	// Guard the array invariant the binary search depends on.
	assertSorted(t, "accNameKeys", accNameKeys)
	assertSorted(t, "jobNameKeys", jobNameKeys)
	assertSorted(t, "robeKeys", robeKeys)
	assertSorted(t, "robeEngKeys", robeEngKeys)
	assertSorted(t, "weaponKeys", weaponKeys)
	assertSorted(t, "realWeaponKeys", realWeaponKeys)
	assertSorted(t, "topLayerIDs", topLayerIDs)

	assertPaired(t, "accName", len(accNameKeys), len(accNameVals))
	assertPaired(t, "jobName", len(jobNameKeys), len(jobNameVals))
	assertPaired(t, "robe", len(robeKeys), len(robeVals))
	assertPaired(t, "robeEng", len(robeEngKeys), len(robeEngVals))
	assertPaired(t, "weapon", len(weaponKeys), len(weaponVals))
	assertPaired(t, "realWeapon", len(realWeaponKeys), len(realWeaponVals))
}

func TestBakedLayerPriorityMatchesJSON(t *testing.T) {
	var src map[string]jsonLayerPriority
	readTestJSON(t, "layer_priority.json", &src)

	if len(src) != len(layerPriorityTable) {
		t.Errorf("layer priority: baked %d entries, JSON has %d — run `go generate ./...`",
			len(layerPriorityTable), len(src))
	}

	tbl := DefaultTables()
	for k, v := range src {
		id64, err := strconv.ParseUint(k, 10, 32)
		if err != nil {
			continue
		}
		id := uint32(id64)
		for d := 0; d < 8; d++ {
			want, wantOK := expectedBehind(v, d)
			got, gotOK := tbl.HeadgearBehind(id, d)
			if got != want || gotOK != wantOK {
				t.Errorf("HeadgearBehind(%d, %d) = (%v,%v), JSON implies (%v,%v)",
					id, d, got, gotOK, want, wantOK)
			}
		}
	}
}

// expectedBehind reimplements the rule straight from the JSON shape, so the test
// is not just asserting the baked data against itself.
func expectedBehind(v jsonLayerPriority, dir int) (behind, ok bool) {
	if dv, has := v.Dir[strconv.Itoa(dir)]; has {
		return dv < 0, true
	}
	if v.Default != nil {
		return *v.Default < 0, true
	}
	return false, false
}

func assertSorted(t *testing.T, name string, keys []uint32) {
	t.Helper()
	for i := 1; i < len(keys); i++ {
		if keys[i-1] >= keys[i] {
			t.Fatalf("%s not strictly ascending at %d (%d >= %d); binary search would be wrong",
				name, i, keys[i-1], keys[i])
		}
	}
}

func assertPaired(t *testing.T, name string, nKeys, nVals int) {
	t.Helper()
	if nKeys != nVals {
		t.Errorf("%s: %d keys but %d values", name, nKeys, nVals)
	}
}
