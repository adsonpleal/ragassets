package resolve

import "sort"

//go:generate go run ../../../cmd/gen-tables

// bakedTables is the generated, client-derived lookup data (see cmd/gen-resolver
// for the JSON, cmd/gen-tables for the bake). Names are already decoded to UTF-8
// and lowercased. Functions the client's .lub did not provide (ShadowFactor,
// DoramOffset) fall back to the same defaults zrenderer uses when those Lua
// functions are unavailable.
//
// The data lives in tables_baked_gen.go as package-level sorted arrays rather
// than being unmarshalled from embedded JSON at init. That keeps encoding/json —
// and therefore reflection — out of the render path entirely, and means the
// tables cost nothing to "load": they are static data in the binary, and a
// lookup is a binary search over it.
type bakedTables struct{}

// DefaultTables returns the Tables backed by the generated data.
//
// It no longer returns an error or panics: there is nothing to parse, so a
// malformed table is now a compile error in tables_baked_gen.go rather than a
// runtime panic on first use.
func DefaultTables() Tables { return bakedTables{} }

// layerPriority is one accessory's draw-priority data: an optional default plus
// per-direction overrides. The effective priority for a direction is the override
// if present, else the default; negative means "draw behind the body".
type layerPriority struct {
	def        int
	hasDefault bool
	dir        map[int]int
}

// lookupString binary-searches the sorted key array and returns the parallel
// value, or "" when the id is absent.
func lookupString(keys []uint32, vals []string, id uint32) string {
	i := sort.Search(len(keys), func(i int) bool { return keys[i] >= id })
	if i < len(keys) && keys[i] == id {
		return vals[i]
	}
	return ""
}

// containsUint reports whether the sorted array holds id.
func containsUint(keys []uint32, id uint32) bool {
	i := sort.Search(len(keys), func(i int) bool { return keys[i] >= id })
	return i < len(keys) && keys[i] == id
}

func (bakedTables) AccName(id uint32) string { return lookupString(accNameKeys, accNameVals, id) }

func (bakedTables) RobeSprName(id uint32, english bool) string {
	if english {
		return lookupString(robeEngKeys, robeEngVals, id)
	}
	return lookupString(robeKeys, robeVals, id)
}

func (bakedTables) WeaponName(id uint32) string { return lookupString(weaponKeys, weaponVals, id) }

func (bakedTables) RealWeaponID(id uint32) uint32 {
	i := sort.Search(len(realWeaponKeys), func(i int) bool { return realWeaponKeys[i] >= id })
	if i < len(realWeaponKeys) && realWeaponKeys[i] == id {
		return realWeaponVals[i]
	}
	return id
}

func (bakedTables) JobName(id uint32) string { return lookupString(jobNameKeys, jobNameVals, id) }

func (bakedTables) IsTopLayer(id uint32) bool { return containsUint(topLayerIDs, id) }

// HeadgearBehind applies the TB_Layer_Priority rule: the effective priority for
// the direction (override if present, else the default) being negative means the
// accessory draws behind the body. ok is false when id has no entry.
func (bakedTables) HeadgearBehind(id uint32, direction int) (bool, bool) {
	lp, ok := layerPriorityTable[id]
	if !ok {
		return false, false
	}
	if v, has := lp.dir[direction]; has {
		return v < 0, true
	}
	if lp.hasDefault {
		return lp.def < 0, true
	}
	return false, false
}

// ShadowFactor / DoramOffset were not provided by the client .lub (the same
// situation in which zrenderer falls back to defaults).
func (bakedTables) ShadowFactor(uint32) float32 { return 1 }
func (bakedTables) DoramOffset(uint32, int, int) (int, int, bool) {
	return 0, 0, false
}
