// Package rotype holds the small shared enums used across the renderer (gender,
// head direction, madogear type, player/monster actions). It mirrors the enums
// in zrenderer's config.d and sprite.d and depends on nothing else.
package rotype

// Gender of a player character.
type Gender int

const (
	Female Gender = 0
	Male   Gender = 1
)

// Int returns the numeric gender used by Lua lookups (female=0, male=1).
func (g Gender) Int() int {
	if g == Male {
		return 1
	}
	return 0
}

// String returns the Korean folder token used in sprite paths (남=male, 여=female).
func (g Gender) String() string {
	if g == Male {
		return "남"
	}
	return "여"
}

// HeadDirection selects which way a player's head faces for stand/sit poses.
// Enum ordinals match zrenderer: straight=0, left=1, right=2, all=3.
type HeadDirection int

const (
	Straight HeadDirection = 0
	Left     HeadDirection = 1
	Right    HeadDirection = 2
	All      HeadDirection = 3
)

// FrameDir maps the head direction to the RO sub-frame index (zrenderer's
// HeadDirection.toInt): straight=0, right=1, left=2; all/other default to 0.
func (h HeadDirection) FrameDir() int {
	switch h {
	case Straight:
		return 0
	case Right:
		return 1
	case Left:
		return 2
	default:
		return 0
	}
}

// MadogearType selects the madogear sprite variant.
type MadogearType int

const (
	MadogearRobot  MadogearType = 0
	MadogearUnused MadogearType = 1
	MadogearSuit   MadogearType = 2
)

func (m MadogearType) Int() int { return int(m) }

// PlayerAction is the action "family" (each spans 8 directions).
type PlayerAction uint

const (
	ActStand      PlayerAction = 0
	ActMove       PlayerAction = 8
	ActSit        PlayerAction = 16
	ActPickup     PlayerAction = 24
	ActAttackWait PlayerAction = 32
	ActAttack     PlayerAction = 40
	ActDamage     PlayerAction = 48
	ActDamage2    PlayerAction = 56
	ActDead       PlayerAction = 64
	ActUnk        PlayerAction = 72
	ActAttack2    PlayerAction = 80
	ActAttack3    PlayerAction = 88
	ActSkill      PlayerAction = 96
	ActInvalid    PlayerAction = 255
)

// IntToPlayerAction maps a raw action index (action = family + direction) to its
// family, or ActInvalid if out of range. Mirrors sprite.d intToPlayerAction.
func IntToPlayerAction(action uint) PlayerAction {
	base := action - (action % 8)
	if base > uint(ActSkill) {
		return ActInvalid
	}
	return PlayerAction(base)
}

// MonsterAction is the monster action family.
type MonsterAction uint

const (
	MonStand   MonsterAction = 0
	MonMove    MonsterAction = 8
	MonAttack  MonsterAction = 16
	MonDamage  MonsterAction = 24
	MonDead    MonsterAction = 32
	MonInvalid MonsterAction = 255
)

// IntToMonsterAction maps a raw action index to its monster family.
func IntToMonsterAction(action uint) MonsterAction {
	base := action - (action % 8)
	if base > uint(MonDead) {
		return MonInvalid
	}
	return MonsterAction(base)
}
