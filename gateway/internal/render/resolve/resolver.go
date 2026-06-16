package resolve

import (
	"strconv"
	"strings"

	"github.com/ragassets/zrenderer-gateway/internal/render/rotype"
)

// Korean path tokens used in resolved sprite/palette paths.
const (
	kHuman      = "인간족"  // human race
	kDoram      = "도람족"  // doram race
	kBodyDir    = "몸통"   // body sprite folder
	kHeadDir    = "머리통"  // head sprite folder
	kAccessory  = "악세사리" // accessory (headgear) folder
	kRobe       = "로브"   // garment/robe folder
	kHairPal    = "머리"   // head palette folder (and doram hair)
	kBodyPal    = "몸"    // body palette folder
	kShield     = "방패"   // shield folder
	kMonster    = "몬스터"  // monster folder
	kMerc       = "용병"   // mercenary folder
	kHairPrefix = "머리"   // head palette filename prefix ("머리<id>_...")
)

// Resolver builds on-disk-relative paths for the sprite layers of a render.
type Resolver struct {
	static staticTables
	tables Tables
}

// New returns a Resolver using the given client-derived Tables (use NopTables
// when none are available).
func New(tables Tables) *Resolver {
	if tables == nil {
		tables = NopTables{}
	}
	return &Resolver{static: loadStaticTables(), tables: tables}
}

func join(parts ...string) string { return strings.Join(parts, "/") }

func itoa(v int) string    { return strconv.Itoa(v) }
func utoa(v uint32) string { return strconv.FormatUint(uint64(v), 10) }

// JobSpriteName returns the body sprite base name for a job.
func (r *Resolver) JobSpriteName(jobID uint32, mado rotype.MadogearType) string {
	if IsPlayer(jobID) {
		if IsMadogear(jobID) && mado == rotype.MadogearSuit {
			return AlternativeMadogearJobName(jobID)
		}
		j := jobID
		if j > 4000 {
			j -= advancedJobIndex
		}
		if int(j) < len(r.static.jobNames) {
			return r.static.jobNames[j]
		}
		return ""
	}
	return r.tables.JobName(jobID)
}

// ImfName returns the head-priority imf base name for a player job.
func (r *Resolver) ImfName(jobID uint32, gender rotype.Gender, mado rotype.MadogearType) string {
	if !IsPlayer(jobID) {
		return ""
	}
	if IsMadogear(jobID) && mado == rotype.MadogearSuit {
		return AlternativeMadogearJobName(jobID) + "_" + gender.String()
	}
	j := jobID
	if j > 4000 {
		j -= advancedJobIndex
	}
	if int(j) >= len(r.static.imfNames) {
		return ""
	}
	return r.static.imfNames[j] + "_" + gender.String()
}

// PlayerBodySprite returns the body sprite path.
func (r *Resolver) PlayerBodySprite(jobID uint32, gender rotype.Gender, mado rotype.MadogearType) string {
	if !IsPlayer(jobID) {
		return ""
	}
	jobname := r.JobSpriteName(jobID, mado)
	race := kHuman
	if IsDoram(jobID) {
		race = kDoram
	}
	return join(race, kBodyDir, gender.String(), jobname+"_"+gender.String())
}

// PlayerBodyAltSprite returns the alternative-outfit body sprite path.
func (r *Resolver) PlayerBodyAltSprite(jobID uint32, gender rotype.Gender, costumeID uint32, mado rotype.MadogearType) string {
	if !IsPlayer(jobID) {
		return ""
	}
	jobname := r.JobSpriteName(jobID, mado)
	costume := utoa(costumeID)
	race := kHuman
	if IsDoram(jobID) {
		race = kDoram
	}
	return join(race, kBodyDir, gender.String(), "costume_"+costume, jobname+"_"+gender.String()+"_"+costume)
}

// PlayerHeadSprite returns the head sprite path.
func (r *Resolver) PlayerHeadSprite(jobID, headID uint32, gender rotype.Gender) string {
	if IsWereform(jobID) {
		return ""
	}
	race := kHuman
	if IsDoram(jobID) {
		race = kDoram
	}
	return join(race, kHeadDir, gender.String(), utoa(headID)+"_"+gender.String())
}

// NonPlayerSprite returns the body sprite path for monsters/NPCs/homun/merc.
func (r *Resolver) NonPlayerSprite(jobID uint32) string {
	if IsPlayer(jobID) {
		return ""
	}
	jobname := r.JobSpriteName(jobID, rotype.MadogearRobot)
	if jobname == "" {
		return ""
	}
	switch {
	case IsNPC(jobID):
		return join("npc", jobname)
	case IsMercenary(jobID):
		return join(kHuman, kBodyDir, jobname)
	case IsHomunculus(jobID):
		return join("homun", jobname)
	case IsMonster(jobID):
		return join(kMonster, jobname)
	}
	return ""
}

// BodyPalette returns the body palette path.
func (r *Resolver) BodyPalette(jobID uint32, paletteID int, gender rotype.Gender, mado rotype.MadogearType) string {
	if !IsPlayer(jobID) {
		return ""
	}
	pal := itoa(paletteID)
	if IsMadogear(jobID) && mado == rotype.MadogearSuit {
		return join(kBodyPal, AlternativeMadogearJobName(jobID)+"_"+gender.String()+"_"+pal)
	}
	doram := IsDoram(jobID)
	were := IsWereform(jobID)
	j := jobID
	if j > 4000 {
		j -= advancedJobIndex
	}
	if int(j) >= len(r.static.jobPalNames) {
		return ""
	}
	name := r.static.jobPalNames[j]
	switch {
	case doram:
		return join(kDoram, "body", name+"_"+gender.String()+"_"+pal)
	case were:
		return join(kBodyPal, name+"_"+pal)
	default:
		return join(kBodyPal, name+"_"+gender.String()+"_"+pal)
	}
}

// BodyAltPalette returns the alternative-outfit body palette path.
func (r *Resolver) BodyAltPalette(jobID uint32, paletteID int, gender rotype.Gender, costumeID uint32, mado rotype.MadogearType) string {
	if !IsPlayer(jobID) {
		return ""
	}
	pal := itoa(paletteID)
	costume := utoa(costumeID)
	if IsMadogear(jobID) && mado == rotype.MadogearSuit {
		return join(kBodyPal, "costume_"+costume,
			AlternativeMadogearJobName(jobID)+"_"+gender.String()+"_"+pal+"_"+costume)
	}
	doram := IsDoram(jobID)
	j := jobID
	if j > 4000 {
		j -= advancedJobIndex
	}
	if int(j) >= len(r.static.jobPalNames) {
		return ""
	}
	name := r.static.jobPalNames[j]
	if doram {
		return join(kDoram, "body", "costume_"+costume, name+"_"+gender.String()+"_"+pal+"_"+costume)
	}
	return join(kBodyPal, "costume_"+costume, name+"_"+gender.String()+"_"+pal+"_"+costume)
}

// HeadPalette returns the head palette path.
func (r *Resolver) HeadPalette(jobID, headID uint32, paletteID int, gender rotype.Gender) string {
	if !IsPlayer(jobID) || IsWereform(jobID) {
		return ""
	}
	pal := itoa(paletteID)
	name := kHairPrefix + utoa(headID) + "_" + gender.String() + "_" + pal
	if IsDoram(jobID) {
		return join(kDoram, kHairPal, name)
	}
	return join(kHairPal, name)
}

// HeadgearSprite returns the accessory (headgear) sprite path, or "" if unknown.
func (r *Resolver) HeadgearSprite(headgearID uint32, gender rotype.Gender) string {
	accName := r.tables.AccName(headgearID)
	if accName == "" {
		return ""
	}
	return join(kAccessory, gender.String(), gender.String()+accName)
}

// GarmentSprite returns a garment/robe sprite path. english selects the
// English-named robe table; fallback returns the shared (non per-job) path used
// by newer garments. Returns "" if the garment id is unknown.
func (r *Resolver) GarmentSprite(jobID, garmentID uint32, gender rotype.Gender, english, fallback bool) string {
	if !IsPlayer(jobID) || IsWereform(jobID) {
		return ""
	}
	jobname := r.JobSpriteName(jobID, rotype.MadogearRobot)
	garmentName := r.tables.RobeSprName(garmentID, english)
	if garmentName == "" {
		return ""
	}
	if fallback {
		return join(kRobe, garmentName, garmentName)
	}
	return join(kRobe, garmentName, gender.String(), jobname+"_"+gender.String())
}

// GarmentCandidates returns the candidate garment sprite base paths (act and spr
// share each base, so they are a matched pair) in priority order. Garments use
// several folder layouts: classic per-job (로브/N/<g>/<job>_<g>), nested per-job
// (로브/N/N/<g>/<job>_<g>, used by newer costumes like c_rata_tail), and a shared
// single sprite (로브/N/N). The caller picks the first base where both files exist.
func (r *Resolver) GarmentCandidates(jobID, garmentID uint32, gender rotype.Gender) []string {
	if !IsPlayer(jobID) || IsWereform(jobID) {
		return nil
	}
	jobname := r.JobSpriteName(jobID, rotype.MadogearRobot)
	g := gender.String()

	var out []string
	seen := map[string]bool{}
	addName := func(name string) {
		if name == "" {
			return
		}
		for _, p := range []string{
			join(kRobe, name, g, jobname+"_"+g),       // classic per-job
			join(kRobe, name, name, g, jobname+"_"+g), // nested per-job
			join(kRobe, name, name),                   // shared single sprite
		} {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	addName(r.tables.RobeSprName(garmentID, false))
	addName(r.tables.RobeSprName(garmentID, true))
	return out
}

// WeaponSprite returns a weapon sprite path for players and mercenaries.
func (r *Resolver) WeaponSprite(jobID, weaponID uint32, gender rotype.Gender, mado rotype.MadogearType) string {
	isPlayer := IsPlayer(jobID)
	isMerc := IsMercenary(jobID)
	if (!isPlayer || IsWereform(jobID)) && !isMerc {
		return ""
	}

	if isPlayer {
		doram := IsDoram(jobID)
		isMado := IsMadogear(jobID)
		isAltMado := isMado && mado == rotype.MadogearSuit

		j := jobID
		if j > 4000 {
			j -= advancedJobIndex
		}
		if int(j) >= len(r.static.weaponNames) {
			return ""
		}
		jobWeaponName := r.static.weaponNames[j]
		if isAltMado {
			if i := strings.IndexByte(jobWeaponName, '/'); i >= 0 {
				jobWeaponName = jobWeaponName[:i+1] + AlternativeMadogearJobName(jobID)
			}
		}

		weaponName := r.tables.WeaponName(weaponID)
		if weaponName == "" && !isMado {
			weaponID = r.tables.RealWeaponID(weaponID)
			weaponName = r.tables.WeaponName(weaponID)
			if weaponName == "" {
				weaponName = "_" + utoa(weaponID)
			}
		}
		if weaponName == "" && !isMado {
			return ""
		}

		race := kHuman
		if doram {
			race = kDoram
		}
		return join(race, jobWeaponName+"_"+gender.String()+weaponName)
	}

	// Mercenary weapons are fixed per class group.
	switch {
	case jobID-6017 <= 9: // archer
		return join(kHuman, kMerc, "활용병_활")
	case jobID-6027 <= 9: // lancer
		return join(kHuman, kMerc, "창용병_창")
	default: // swordsman
		return join(kHuman, kMerc, "검용병_검")
	}
}

// ShieldSprite returns a shield sprite path.
func (r *Resolver) ShieldSprite(jobID, shieldID uint32, gender rotype.Gender) string {
	if !IsPlayer(jobID) || IsWereform(jobID) {
		return ""
	}
	jobname := r.JobSpriteName(jobID, rotype.MadogearRobot)
	if int(shieldID) < len(r.static.shieldNames) {
		return join(kShield, jobname, jobname+"_"+gender.String()+r.static.shieldNames[shieldID])
	}
	return join(kShield, jobname, jobname+"_"+gender.String()+"_"+utoa(shieldID)+"_방패")
}

// AlternativeMadogearJobName returns the hardcoded alternate madogear job name.
func AlternativeMadogearJobName(jobID uint32) string {
	if jobID == 4086 || jobID == 4087 || jobID == 4112 {
		return "마도아머" // Mechanic
	}
	return "meister_madogear2" // Meister
}
