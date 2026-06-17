package resolve

import (
	_ "embed"
	"strings"
)

// Static job-name tables shipped with zrenderer (resolver_data/*.txt). Each line
// is one entry indexed by job id; Korean entries are unaffected by lowercasing,
// latin class names are already lowercase.
var (
	//go:embed data/job_names.txt
	rawJobNames string
	//go:embed data/imf_names.txt
	rawImfNames string
	//go:embed data/job_pal_names.txt
	rawJobPalNames string
	//go:embed data/job_weapon_names.txt
	rawJobWeaponNames string
	//go:embed data/shield_names.txt
	rawShieldNames string
)

// staticTables holds the parsed job-name tables.
type staticTables struct {
	jobNames    []string
	imfNames    []string
	jobPalNames []string
	weaponNames []string // per-job weapon path prefix (may contain backslashes)
	shieldNames []string
}

func loadStaticTables() staticTables {
	weapons := splitLines(rawJobWeaponNames)
	// Weapon names embed a backslash separating the job folder from the weapon
	// prefix; zrenderer converts it to the OS separator on non-Windows ("/").
	for i := range weapons {
		weapons[i] = strings.ReplaceAll(weapons[i], "\\", "/")
	}
	return staticTables{
		jobNames:    splitLines(rawJobNames),
		imfNames:    splitLines(rawImfNames),
		jobPalNames: splitLines(rawJobPalNames),
		weaponNames: weapons,
		shieldNames: splitLines(rawShieldNames),
	}
}

func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	// Lowercase to match zrenderer (map!(toLower)); trim a trailing empty line.
	for i := range lines {
		lines[i] = strings.ToLower(lines[i])
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// Tables provides the client-derived (GRF .lub) lookups that zrenderer performs
// via Lua. The values are pre-decoded to UTF-8 and lowercased exactly as
// zrenderer would (fromWindows949 → toUTF8 → toLower), with backslashes already
// converted to forward slashes where zrenderer does so. An offline generator
// produces a concrete implementation; NopTables is the empty fallback.
type Tables interface {
	// AccName returns the accessory sprite name for a headgear id (ReqAccName),
	// or "" if unknown.
	AccName(headgearID uint32) string
	// RobeSprName returns the garment/robe sprite name (ReqRobSprName_V2). When
	// english is true the English-named variant is requested.
	RobeSprName(garmentID uint32, english bool) string
	// WeaponName returns the weapon sprite suffix for a weapon id (ReqWeaponName).
	WeaponName(weaponID uint32) string
	// RealWeaponID resolves a weapon id to its underlying view id (GetRealWeaponId).
	RealWeaponID(weaponID uint32) uint32
	// JobName returns the sprite folder/name for a non-player job (ReqJobName),
	// with backslashes converted to forward slashes.
	JobName(jobID uint32) string
	// IsTopLayer reports whether a garment is a top layer (IsTopLayer).
	IsTopLayer(garmentID uint32) bool
	// HeadgearBehind reports whether accessory id should draw behind the body for
	// the given facing direction (0..7), per the client's TB_Layer_Priority table
	// (a negative effective priority means "behind"). ok is false when the
	// accessory has no layer-priority entry, in which case it draws in front.
	HeadgearBehind(accessoryID uint32, direction int) (behind, ok bool)
	// ShadowFactor returns the shadow scale for a job (ReqshadowFactor); 1 default.
	ShadowFactor(jobID uint32) float32
	// DoramOffset returns the per-direction headgear offset for doram characters
	// (OffsetItemPos_GetOffsetForDoram); ok is false when there is no offset.
	DoramOffset(headgearID uint32, direction, gender int) (x, y int, ok bool)
}

// NopTables is a Tables implementation with no client data: name lookups return
// "", z-order helpers return defaults, ShadowFactor returns 1. Used until the
// generated tables are wired in.
type NopTables struct{}

func (NopTables) AccName(uint32) string                         { return "" }
func (NopTables) RobeSprName(uint32, bool) string               { return "" }
func (NopTables) WeaponName(uint32) string                      { return "" }
func (NopTables) RealWeaponID(id uint32) uint32                 { return id }
func (NopTables) JobName(uint32) string                         { return "" }
func (NopTables) IsTopLayer(uint32) bool                        { return false }
func (NopTables) HeadgearBehind(uint32, int) (bool, bool)       { return false, false }
func (NopTables) ShadowFactor(uint32) float32                   { return 1 }
func (NopTables) DoramOffset(uint32, int, int) (int, int, bool) { return 0, 0, false }
