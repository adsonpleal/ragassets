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
