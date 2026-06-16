package resolve

import (
	_ "embed"
	"encoding/json"
	"strconv"
)

//go:embed data/tables.json
var rawTablesJSON []byte

// jsonTables is the generated, client-derived lookup data (see cmd/gen-resolver).
// Names are already decoded to UTF-8 and lowercased. Functions that the client's
// .lub did not provide (DrawOnTop, ShadowFactor, DoramOffset) fall back to the
// same defaults zrenderer uses when those Lua functions are unavailable.
type jsonTables struct {
	accName    map[uint32]string
	robe       map[uint32]string
	robeEng    map[uint32]string
	weapon     map[uint32]string
	realWeapon map[uint32]uint32
	jobName    map[uint32]string
	isTopLayer map[uint32]bool
}

type rawTables struct {
	AccName    map[string]string `json:"accname"`
	Robe       map[string]string `json:"robe"`
	RobeEng    map[string]string `json:"robeEng"`
	Weapon     map[string]string `json:"weapon"`
	RealWeapon map[string]uint32 `json:"realWeapon"`
	JobName    map[string]string `json:"jobName"`
	IsTopLayer map[string]bool   `json:"isTopLayer"`
}

// DefaultTables returns the Tables backed by the embedded generated data. It
// panics on a malformed embed (a build-time invariant).
func DefaultTables() Tables {
	t, err := loadJSONTables(rawTablesJSON)
	if err != nil {
		panic("resolve: bad embedded tables.json: " + err.Error())
	}
	return t
}

func loadJSONTables(data []byte) (*jsonTables, error) {
	var r rawTables
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	t := &jsonTables{
		accName:    keyedByUint(r.AccName),
		robe:       keyedByUint(r.Robe),
		robeEng:    keyedByUint(r.RobeEng),
		weapon:     keyedByUint(r.Weapon),
		jobName:    keyedByUint(r.JobName),
		realWeapon: map[uint32]uint32{},
		isTopLayer: map[uint32]bool{},
	}
	for k, v := range r.RealWeapon {
		if id, err := strconv.ParseUint(k, 10, 32); err == nil {
			t.realWeapon[uint32(id)] = v
		}
	}
	for k, v := range r.IsTopLayer {
		if id, err := strconv.ParseUint(k, 10, 32); err == nil {
			t.isTopLayer[uint32(id)] = v
		}
	}
	return t, nil
}

func keyedByUint(m map[string]string) map[uint32]string {
	out := make(map[uint32]string, len(m))
	for k, v := range m {
		if id, err := strconv.ParseUint(k, 10, 32); err == nil {
			out[uint32(id)] = v
		}
	}
	return out
}

func (t *jsonTables) AccName(id uint32) string { return t.accName[id] }

func (t *jsonTables) RobeSprName(id uint32, english bool) string {
	if english {
		return t.robeEng[id]
	}
	return t.robe[id]
}

func (t *jsonTables) WeaponName(id uint32) string { return t.weapon[id] }

func (t *jsonTables) RealWeaponID(id uint32) uint32 {
	if r, ok := t.realWeapon[id]; ok {
		return r
	}
	return id
}

func (t *jsonTables) JobName(id uint32) string { return t.jobName[id] }

func (t *jsonTables) IsTopLayer(id uint32) bool { return t.isTopLayer[id] }

// ShadowFactor / DoramOffset were not provided by the client .lub (the same
// situation in which zrenderer falls back to defaults).
func (t *jsonTables) ShadowFactor(uint32) float32 { return 1 }
func (t *jsonTables) DoramOffset(uint32, int, int) (int, int, bool) {
	return 0, 0, false
}
