package effect

import "golang.org/x/text/encoding/korean"

// EUCKRReinterpret recovers a Korean asset name that the roBrowser effect table
// stores as raw EUC-KR bytes rendered one-byte-per-rune (latin1). The real client
// requests such a name verbatim and matches it against a GRF file whose stored
// name carries those same bytes; ragassets extracts the tree under decoded UTF-8
// (Hangul) names instead, so a byte-for-byte lookup misses. Reinterpreting the
// name's runes as the original EUC-KR byte stream reproduces the Hangul path.
//
// It returns ok=false (and s unchanged) when the name is plain ASCII (nothing to
// recover), when any rune exceeds one byte (so it wasn't a latin1-rendered byte
// stream), or when the bytes aren't valid EUC-KR. ASCII bytes pass through the
// decoder unchanged, so a mixed name like "effect/<euc-kr>" keeps its prefix.
func EUCKRReinterpret(s string) (string, bool) {
	buf := make([]byte, 0, len(s))
	hasHigh := false
	for _, r := range s {
		if r > 0xff {
			return s, false // a genuine multi-byte rune — not a latin1 byte stream
		}
		if r > 0x7f {
			hasHigh = true
		}
		buf = append(buf, byte(r))
	}
	if !hasHigh {
		return s, false // pure ASCII: nothing to reinterpret
	}
	dec, err := korean.EUCKR.NewDecoder().Bytes(buf)
	if err != nil {
		return s, false
	}
	return string(dec), true
}
