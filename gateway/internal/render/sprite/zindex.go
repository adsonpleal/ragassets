package sprite

import "github.com/ragassets/gateway/internal/render/roformat"

// IsTopLeftDir reports whether a facing direction (0..7) draws "top-left", which
// flips several z-order relationships. Directions 2..5 are top-left.
func IsTopLeftDir(direction int) bool { return direction >= 2 && direction <= 5 }

// ZIndexForSprite returns the draw order for a non-garment sprite, mirroring
// sprite.d zIndexForSprite. action/frame are -1 when unused; bodyImf may be nil.
// When the body IMF marks the head as priority 1 for the given action/frame, the
// head is drawn just in front of/behind the body.
func ZIndexForSprite(s *Sprite, direction, action, frame int, bodyImf *roformat.Imf) int {
	if s.Type == TypeShadow {
		return -1
	}
	// Effect-type accessories (auras/halos) draw behind the body and head, in all
	// directions — above the shadow (-1), below the body (10/15).
	if s.Behind && s.Type == TypeAccessory {
		return 1 + s.TypeOrder
	}
	headBeforeBody := bodyImf != nil && action >= 0 && frame >= 0 && bodyImf.Priority(1, action, frame) == 1

	if IsTopLeftDir(direction) {
		switch s.Type {
		case TypePlayerBody:
			return 15
		case TypePlayerHead:
			if headBeforeBody {
				return 14
			}
			return 20
		case TypeAccessory:
			return 25 - (3 - s.TypeOrder)
		case TypeWeapon:
			return 30 - (2 - s.TypeOrder)
		case TypeShield:
			return 10
		default:
			return 0
		}
	}

	switch s.Type {
	case TypePlayerBody:
		return 10
	case TypePlayerHead:
		if headBeforeBody {
			return 9
		}
		return 15
	case TypeAccessory:
		return 20 - (3 - s.TypeOrder)
	case TypeWeapon:
		return 25 - (2 - s.TypeOrder)
	case TypeShield:
		return 30
	default:
		return 0
	}
}
