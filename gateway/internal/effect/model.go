package effect

// ModelExts are the extensions a model token may resolve under, in the order
// they are tried.
//
// 23 of the client's ground-skill unit types draw no effect at all: they stand
// as a 3D model, named by a GRF path in the unit table (rustnarok-client's
// effects.txt `rsm` rows). Those names come in both shapes — the classic trap
// props carry no extension (`외부소품\트랩01`, resolved as `.rsm`) and the
// 4th-job ones spell theirs out (`effect\deepblindtrap\deep_trap.rsm2`) — so
// both are tried, and Store.Resolve takes a token that already ends in one of
// these verbatim first.
//
// The order matters only for a bare token, where the client itself would append
// `.rsm`: the classic props are far and away the common case, and nothing in
// this client ships the same basename as both a `.rsm` and a `.rsm2`.
//
// Serving them needs no RSM parser here. Both versions in the unit table (1.4
// for the classic props, 2.3 for the 4th-job ones) share the "GRSM" magic and
// differ only in how the geometry inside is laid out, which is the consumer's
// problem — the map pipeline already hands `.rsm` bytes over raw at
// /maps/_m/<hash>.rsm and the viewer parses them there.
var ModelExts = []string{".rsm", ".rsm2"}

// ResolveModel is Resolve for a model token, with the EUC-KR retry the Korean
// names need when they arrive as a latin1 byte stream rather than as decoded
// Hangul.
//
// The extracted tree carries Korean names as UTF-8 (extract-grf.mjs decodes the
// GRF's EUC-KR at extraction time), and that is what a caller passing the name
// through verbatim from a UTF-8 table sends, so the first attempt is the one
// that normally wins. A caller whose own table kept the raw CP949 bytes — which
// is how roBrowser's effect tables carry them, and why resolveSound needs the
// same retry — would otherwise 404 on every Korean-named model.
func (s *Store) ResolveModel(file string) (string, bool) {
	if p, ok := s.Resolve(file, ModelExts); ok {
		return p, true
	}
	if k, ok := EUCKRReinterpret(file); ok {
		if p, ok := s.Resolve(k, ModelExts); ok {
			return p, true
		}
	}
	return "", false
}
