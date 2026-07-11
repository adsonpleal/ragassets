package effect

import "testing"

func TestEUCKRReinterpret(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		// "effect/Èí±â" is the effect table's rendering of the EUC-KR bytes for
		// 흡기 (Absorb Spirits) as one-byte-per-rune latin1; recovering them yields
		// the decoded Hangul path the sound tree is extracted under.
		{"korean with ascii prefix", "effect/Èí±â", "effect/흡기", true},
		{"pure ascii unchanged", "effect/ef_portal", "effect/ef_portal", false},
		{"bare ascii unchanged", "_heal_effect", "_heal_effect", false},
		// A genuine multi-byte rune means it wasn't a latin1 byte stream.
		{"already-unicode is not reinterpreted", "effect/흡기", "effect/흡기", false},
	}
	for _, c := range cases {
		got, ok := EUCKRReinterpret(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: EUCKRReinterpret(%q) = (%q, %v), want (%q, %v)", c.name, c.in, got, ok, c.want, c.ok)
		}
	}
}
