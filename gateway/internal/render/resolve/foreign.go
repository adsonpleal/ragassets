package resolve

// SpriteNames answers the accessory and garment name lookups from a caller-
// supplied map, leaving every other question to the tables underneath.
//
// A costume from another official server has no entry in this client's name
// tables, and both ways that can go are silent. Usually the view id is simply
// absent, and the renderer draws the character with no hat at all — a 200 and a
// PNG that happens to be the bare head, indistinguishable from a request that
// asked for nothing. Sometimes the id is present and means a different hat
// here, and the renderer draws that one instead, which is worse: the picture
// looks right and is wrong.
//
// Neither can be fixed from an id, because the id is not the costume — it is
// that client's index into its own table. So the caller that does know the
// costume (a catalogue built from that server's client) names the sprite
// outright. Everything else about the headgear still resolves from the id,
// which is the same in every client: draw order, slot priority, whether it
// sits behind the body, whether it survives riding.
//
// Names must arrive in the mirror's convention — lowercased, as extract-grf.mjs
// writes every path under data/ — and without the gender prefix the resolver
// adds (`_two_tone_hat`, not `남_two_tone_hat`).
type SpriteNames struct {
	Tables
	Acc  map[uint32]string
	Robe map[uint32]string
}

// AccName returns the overridden accessory name for id, or the table's answer.
func (s SpriteNames) AccName(id uint32) string {
	if n, ok := s.Acc[id]; ok && n != "" {
		return n
	}
	return s.Tables.AccName(id)
}

// RobeSprName returns the overridden garment name for id, or the table's answer.
// The english flag selects between the two LATAM robe tables and has no meaning
// for an override: a foreign garment has exactly one name, the one on disk.
func (s SpriteNames) RobeSprName(id uint32, english bool) string {
	if n, ok := s.Robe[id]; ok && n != "" {
		return n
	}
	return s.Tables.RobeSprName(id, english)
}
