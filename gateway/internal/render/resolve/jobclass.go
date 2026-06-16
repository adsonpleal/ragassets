// Package resolve maps numeric IDs (job, head, headgear, garment, weapon,
// shield, palette) to the on-disk sprite/palette paths the renderer loads. It
// mirrors zrenderer's resolver.d: static job-name tables shipped with the engine
// plus client-derived lookup tables (injected via Tables, generated offline).
package resolve

// NoJobID is the sentinel "render head only, no body" job (zrenderer's NoJobId =
// uint.max-1).
const NoJobID = ^uint32(0) - 1

// advancedJobIndex is subtracted from job ids > 4000 to index the static tables.
const advancedJobIndex = 3950

// The predicates below classify a job id into a sprite family. They are a direct
// port of resolver.d:8-56 (unsigned wraparound arithmetic preserved).

func IsNPC(id uint32) bool {
	return (id >= 45 && id < 1000) || (id >= 10001 && id < 19999)
}

func IsMercenary(id uint32) bool { return id-6017 <= 29 }

func IsHomunculus(id uint32) bool { return id-6001 <= 51 }

func IsMonster(id uint32) bool {
	return (id >= 1001 && id < 3999) || id >= 20000
}

func IsPlayer(id uint32) bool {
	return id < 45 || (id-4001 < 1999) || id == NoJobID
}

func IsDoram(id uint32) bool {
	return (id-4217 <= 4) || id == 4308 || id == 4315
}

func IsBaby(id uint32) bool {
	return ((id >= 4023 && id <= 4045) || (id >= 4096 && id <= 4112) ||
		(id >= 4158 && id <= 4182) || id == 4191 || id == 4193 ||
		id == 4195 || id == 4196 || (id >= 4205 && id <= 4210) ||
		(id >= 4220 && id <= 4238) || id == 4241 || id == 4242 ||
		id == 4244 || id == 4247 || id == 4248 || id == 4352 ||
		id == 4354)
}

func IsMadogear(id uint32) bool {
	return id == 4086 || id == 4087 || id == 4112 || id == 4279
}

func IsWereform(id uint32) bool { return id == 4356 || id == 4357 }
