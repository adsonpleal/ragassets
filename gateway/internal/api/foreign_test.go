package api

import (
	"net/url"
	"strings"
	"testing"
)

func q(s string) url.Values {
	v, err := url.ParseQuery(s)
	if err != nil {
		panic(err)
	}
	return v
}

func TestBuildForeignEmptyByDefault(t *testing.T) {
	// The overwhelmingly common request names no origin, and must not pay for
	// this feature or behave differently because it exists.
	f, err := BuildForeign(q("job=0&headgear=771"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.Empty() {
		t.Fatalf("a request with no origin should be Empty, got %+v", f)
	}
}

func TestBuildForeignReadsOriginAndNames(t *testing.T) {
	f, err := BuildForeign(q("origin=twrozero&headgearSprite=2904:_C_Harword_Doll_Hat&garmentSprite=28:C_2018_RTC_Cape_TW"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(f.Origins) != 1 || f.Origins[0] != "twrozero" {
		t.Errorf("origins = %v, want [twrozero]", f.Origins)
	}
	// Lowercased: every path under a mirror's data/ is written lowercase, and
	// mixed case would work on Windows and 404 on the server.
	if got := f.Headgear[2904]; got != "_c_harword_doll_hat" {
		t.Errorf("headgear name = %q, want the lowercased name", got)
	}
	if got := f.Garment[28]; got != "c_2018_rtc_cape_tw" {
		t.Errorf("garment name = %q, want the lowercased name", got)
	}
}

func TestBuildForeignRejectsNamesWithoutAnOrigin(t *testing.T) {
	// Without an origin the name would be read from the LATAM tree, where it is
	// either absent or someone else's art. That is the failure this parameter
	// exists to prevent, so it must not be reachable by forgetting one param.
	_, err := BuildForeign(q("headgearSprite=2904:_c_harword_doll_hat"))
	if err == nil {
		t.Fatal("a sprite name with no origin should be refused")
	}
	if !strings.Contains(err.Error(), "origin") {
		t.Errorf("error should say an origin is needed, got %q", err)
	}
}

func TestBuildForeignRejectsPathEscapes(t *testing.T) {
	// A sprite name becomes a path segment, so anything that could leave the
	// tree has to be refused before it reaches a filesystem.
	for _, bad := range []string{
		"origin=iro&headgearSprite=1:../../etc/passwd",
		`origin=iro&headgearSprite=1:..\..\secret`,
		"origin=iro&headgearSprite=1:sub/dir",
		"origin=iro&headgearSprite=1:..",
		"origin=iro&headgearSprite=1:",
	} {
		if _, err := BuildForeign(q(bad)); err == nil {
			t.Errorf("%s: should be refused", bad)
		}
	}
}

func TestParseOriginIDRejectsAnythingButLowercaseAlnum(t *testing.T) {
	for _, ok := range []string{"iro", "jro", "twrozero", "krozero", "kro", "twro"} {
		if _, err := ParseOriginID(ok); err != nil {
			t.Errorf("%q should be valid: %v", ok, err)
		}
	}
	// "." and "/" are the dangerous ones (they are path), the rest keeps the id
	// space small enough that a directory name can be compared literally.
	for _, bad := range []string{"", "..", "../x", "a/b", "IRO", "i-ro", "i_ro", "i ro", strings.Repeat("x", 33)} {
		if _, err := ParseOriginID(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestBuildForeignRejectsMalformedPairs(t *testing.T) {
	for _, bad := range []string{
		"origin=iro&headgearSprite=_no_id_here",
		"origin=iro&headgearSprite=notanumber:_hat",
		"origin=iro&headgearSprite=",
		// The same view named twice, differently: one of the two is a bug, and
		// picking either silently would draw a hat the caller did not ask for.
		"origin=iro&headgearSprite=1:_hat_a,1:_hat_b",
	} {
		if _, err := BuildForeign(q(bad)); err == nil {
			t.Errorf("%s: should be refused", bad)
		}
	}
	// Naming the same view twice the same way is harmless, not a mistake.
	if _, err := BuildForeign(q("origin=iro&headgearSprite=1:_hat,1:_HAT")); err != nil {
		t.Errorf("a repeated identical name should be accepted: %v", err)
	}
}

func TestETagSeparatesOrigins(t *testing.T) {
	// The ETag is the cache key the whole world holds for a year. Two origins
	// rendering the same view id must never share one.
	a := ETagFor(q("job=0&headgear=6&origin=krozero&headgearSprite=6:_두건"))
	b := ETagFor(q("job=0&headgear=6&origin=kro&headgearSprite=6:_두건"))
	c := ETagFor(q("job=0&headgear=6"))
	if a == b || a == c || b == c {
		t.Errorf("origins must not share an ETag: %s %s %s", a[:8], b[:8], c[:8])
	}
}

func TestBuildForeignCombinesOrigins(t *testing.T) {
	// A hat from one server and a garment from another is an ordinary thing to
	// want, and the overlay reads them in the order given.
	f, err := BuildForeign(q("origin=twrozero,iro&headgearSprite=2904:_hat&garmentSprite=40:cherryfesribbon"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(f.Origins) != 2 || f.Origins[0] != "twrozero" || f.Origins[1] != "iro" {
		t.Fatalf("origins = %v, want [twrozero iro] in that order", f.Origins)
	}

	// A repeat is not a second layer; it would only change the cache key.
	f, err = BuildForeign(q("origin=iro,iro&headgearSprite=1:_hat"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(f.Origins) != 1 {
		t.Errorf("origins = %v, want the duplicate collapsed", f.Origins)
	}

	// More than a character can wear is a caller mistake, and each extra tree
	// is another layer every probe walks.
	if _, err := BuildForeign(q("origin=a,b,c,d,e&headgearSprite=1:_hat")); err == nil {
		t.Error("more than MaxOrigins should be refused")
	}
}

func TestBuildCostumeIconDefaultsToTheInventoryIcon(t *testing.T) {
	// A grid of costumes wants the small one, so that is what a request with no
	// 'kind' gets; the collection picture is asked for by name.
	ic, err := BuildCostumeIcon(q("sprite=_C_Chained_Bear"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ic.Kind != "item" {
		t.Errorf("kind = %q, want item", ic.Kind)
	}
	// Lowercased and with the accessory table's leading underscore gone, which
	// is the form stage6-icons.mjs writes the file under.
	if ic.Sprite != "c_chained_bear" {
		t.Errorf("sprite = %q, want c_chained_bear", ic.Sprite)
	}

	ic, err = BuildCostumeIcon(q("sprite=c_chained_bear&kind=collection"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ic.Kind != "collection" || ic.Sprite != "c_chained_bear" {
		t.Errorf("got %+v, want collection/c_chained_bear", ic)
	}
}

func TestBuildCostumeIconKeepsKoreanNames(t *testing.T) {
	// The reason this route is query-shaped at all: most foreign costume sprite
	// names are not spellable in the /icons/{kind}/<name>.png pattern. They must
	// survive parsing unchanged apart from the underscore.
	for _, c := range []struct{ in, want string }{
		{"sprite=%EC%BA%A1", "캡"},                                    // 캡, a garment name with no underscore
		{"sprite=_%EC%BA%A1", "캡"},                                   // the accessory table's _캡
		{"sprite=_c7%ED%95%99%EB%85%84%ED%92%8D%EC%84%A0", "c7학년풍선"}, // mixed ASCII and Hangul
	} {
		ic, err := BuildCostumeIcon(q(c.in))
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", c.in, err)
		}
		if ic.Sprite != c.want {
			t.Errorf("%s: sprite = %q, want %q", c.in, ic.Sprite, c.want)
		}
	}
}

func TestBuildCostumeIconRejectsBadInput(t *testing.T) {
	for _, c := range []struct{ query, why string }{
		{"", "no sprite at all"},
		{"kind=item", "kind without a sprite"},
		{"sprite=", "an empty sprite name"},
		{"sprite=___", "a name of nothing but underscores"},
		{"sprite=_hat&kind=portrait", "a kind that is not one of the two directories"},
		{"sprite=../../main.go", "a parent reference"},
		{"sprite=item/_hat", "a path separator"},
		{`sprite=item\_hat`, "a windows path separator"},
	} {
		if _, err := BuildCostumeIcon(q(c.query)); err == nil {
			t.Errorf("%q (%s) should be refused", c.query, c.why)
		}
	}
}

func TestBuildCostumeIconErrorsNameTheParameter(t *testing.T) {
	// These reach a browser's network tab, so they have to say which parameter
	// was wrong rather than only that something was.
	_, err := BuildCostumeIcon(q("sprite=_hat&kind=portrait"))
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Errorf("error = %v, want it to name 'kind'", err)
	}
	_, err = BuildCostumeIcon(q("kind=item"))
	if err == nil || !strings.Contains(err.Error(), "sprite") {
		t.Errorf("error = %v, want it to name 'sprite'", err)
	}
}
