package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ragassets/gateway/internal/effect"
)

// foreignIconServer builds the flat, sprite-keyed tree stage6-icons.mjs writes:
// <dir>/{item,collection}/<sprite>.png, with no origin in the path.
func foreignIconServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	// A one-pixel PNG; the handler only ever copies bytes, so the smallest
	// valid file is enough and keeps the fixture readable.
	png := []byte("\x89PNG\r\n\x1a\n not really, but these bytes are never decoded here")
	write := func(kind, name string) {
		if err := os.MkdirAll(filepath.Join(dir, kind), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, kind, name+".png"), png, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("item", "c_chained_bear")
	write("collection", "c_chained_bear")
	write("item", "캡")            // a Korean resource name, which is the normal case
	write("item", "c7학년풍선")       // ASCII and Hangul mixed
	write("collection", "c_bell") // collection only, no inventory icon
	// Nothing is written for a sprite no client ships an icon for; those are a
	// 404 on purpose and the consumer falls back to a rendered thumbnail.
	return &server{cfg: config{foreignIconsDir: dir, port: "0"}, flight: newFlightGroup()}
}

func TestCostumeIconEndpoint(t *testing.T) {
	s := foreignIconServer(t)
	cases := []struct {
		query string
		code  int
		why   string
	}{
		{"sprite=c_chained_bear", http.StatusOK, "the default kind is the inventory icon"},
		{"sprite=_c_chained_bear", http.StatusOK, "the catalogue's name, underscore and all, passes through"},
		{"sprite=_C_Chained_Bear", http.StatusOK, "mixed case, because a name table is not lowercase"},
		{"sprite=c_chained_bear&kind=collection", http.StatusOK, "the big picture, asked for by name"},
		{"sprite=%EC%BA%A1", http.StatusOK, "캡, the common shape of a foreign resource name"},
		{"sprite=_%EC%BA%A1", http.StatusOK, "_캡 from the accessory table"},
		{"sprite=_c7%ED%95%99%EB%85%84%ED%92%8D%EC%84%A0", http.StatusOK, "ASCII and Hangul mixed"},
		{"sprite=c_bell&kind=collection", http.StatusOK, "collection present"},
		{"sprite=c_bell", http.StatusNotFound, "no inventory icon for it in any client"},
		{"sprite=c_nothing", http.StatusNotFound, "no icon anywhere; not a placeholder"},
		{"sprite=c_chained_bear&kind=portrait", http.StatusBadRequest, "not one of the two directories"},
		{"", http.StatusBadRequest, "no sprite names nothing"},
		{"sprite=", http.StatusBadRequest, "an empty name"},
	}
	for _, c := range cases {
		rec := get(t, s, s.handleIcon, "/icons/costume?"+c.query)
		if rec.Code != c.code {
			t.Errorf("?%s: status = %d, want %d (%s)", c.query, rec.Code, c.code, c.why)
			continue
		}
		if c.code != http.StatusOK {
			continue
		}
		if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
			t.Errorf("?%s: content-type = %q, want image/png", c.query, ct)
		}
		if rec.Header().Get("Etag") == "" {
			t.Errorf("?%s: missing ETag", c.query)
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("?%s: missing CORS header", c.query)
		}
		if rec.Body.Len() == 0 {
			t.Errorf("?%s: empty body", c.query)
		}
	}
}

// TestCostumeIconTraversal is the test that matters: the key is a free-form
// string from a query, not a number matched against ^[a-z0-9_]+\.png$, so
// nothing about the route's shape stops a name from leaving the directory. Only
// cleanSpriteName does, and this pins it.
func TestCostumeIconTraversal(t *testing.T) {
	s := foreignIconServer(t)
	for _, q := range []string{
		"sprite=../../main.go",
		"sprite=..%2f..%2fmain.go",
		"sprite=%2e%2e/c_chained_bear",
		"sprite=item/c_chained_bear",
		`sprite=item\c_chained_bear`,
		"sprite=/etc/passwd",
		"sprite=c_chained_bear&kind=../item",
		"sprite=c_chained_bear&kind=item/../item",
	} {
		rec := get(t, s, s.handleIcon, "/icons/costume?"+q)
		if rec.Code == http.StatusOK {
			t.Errorf("?%s: served something, want a refusal", q)
		}
	}
}

// TestCostumeIconDoesNotDisturbTheItemIcons is the compatibility gate the brief
// asked for: /icons/item/<id>.png is the LATAM route and must behave exactly as
// it did, including for a store that has not been extracted.
func TestCostumeIconDoesNotDisturbTheItemIcons(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "item"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "item", "501.png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Deliberately no foreignIconsDir: the new route must not be a prerequisite
	// for the old one, and the old one must not read the new store.
	s := &server{cfg: config{iconsDir: dir, port: "0"}, flight: newFlightGroup()}

	if rec := get(t, s, s.handleIcon, "/icons/item/501.png"); rec.Code != http.StatusOK {
		t.Errorf("/icons/item/501.png: status = %d, want 200", rec.Code)
	}
	// "costume" is not a kind, so the path form of it is a 404 and not a
	// half-working alias for the query route.
	if rec := get(t, s, s.handleIcon, "/icons/costume/c_chained_bear.png"); rec.Code != http.StatusNotFound {
		t.Errorf("/icons/costume/<name>.png: status = %d, want 404", rec.Code)
	}
	// And with no store configured the query route is an honest 404, not a panic
	// or a 500.
	if rec := get(t, s, s.handleIcon, "/icons/costume?sprite=c_chained_bear"); rec.Code != http.StatusNotFound {
		t.Errorf("unbuilt store: status = %d, want 404", rec.Code)
	}
}

// TestCostumeIconCacheHeaders pins the policy against the other icons'. These
// files are rewritten in place when the icon run is re-run, exactly like the
// LATAM icons, so they take the same validator-plus-immutable deal rather than
// /raw's revalidating one.
func TestCostumeIconCacheHeaders(t *testing.T) {
	s := foreignIconServer(t)
	rec := get(t, s, s.handleIcon, "/icons/costume?sprite=c_chained_bear")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	etag := rec.Header().Get("Etag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("cache-control = %q, want the same immutable policy /icons uses", cc)
	}

	req := httptest.NewRequest(http.MethodGet, "/icons/costume?sprite=c_chained_bear", nil)
	req.Header.Set("If-None-Match", etag)
	cond := httptest.NewRecorder()
	s.handleIcon(cond, req)
	if cond.Code != http.StatusNotModified {
		t.Errorf("conditional status = %d, want 304", cond.Code)
	}

	// A miss must not be cached as if it were permanent: a later icon run adds
	// files, and these ETags would not change when one arrived.
	miss := get(t, s, s.handleIcon, "/icons/costume?sprite=c_nothing")
	if cc := miss.Header().Get("Cache-Control"); strings.Contains(cc, "immutable") {
		t.Errorf("404 cache-control = %q, must not be immutable", cc)
	}
}

// TestCostumeIconRejectsNonGET goes through the full handler chain rather than
// calling the handler directly, because the CORS header on an error arm comes
// from the middleware and a 405 without it reads to a browser as a CORS failure.
func TestCostumeIconRejectsNonGET(t *testing.T) {
	s := foreignIconServer(t)
	s.cfg.resourceDir = t.TempDir()
	s.estore = effect.NewStore(s.cfg.resourceDir)
	s.mstore = effect.NewModelStore(s.cfg.resourceDir)

	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/icons/costume?sprite=c_chained_bear", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("405 Access-Control-Allow-Origin = %q, want %q", got, "*")
	}

	// The 400 and 404 arms are reached by GET, so they go through the same chain
	// here to confirm they are not CORS failures either.
	for _, tc := range []struct {
		target string
		want   int
	}{
		{"/icons/costume?sprite=c_chained_bear", http.StatusOK},
		{"/icons/costume?sprite=c_nothing", http.StatusNotFound},
		{"/icons/costume?kind=portrait", http.StatusBadRequest},
	} {
		rec := httptest.NewRecorder()
		s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.target, nil))
		if rec.Code != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.target, rec.Code, tc.want)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("%s: Access-Control-Allow-Origin = %q, want %q", tc.target, got, "*")
		}
	}
}
