package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ragassets/gateway/internal/api"
	"github.com/ragassets/gateway/internal/effect"
	"github.com/ragassets/gateway/internal/render/engine"
	"github.com/ragassets/gateway/internal/render/resolve"
)

func newTestServer(t *testing.T) *server {
	t.Helper()
	root := filepath.Join("..", "resources")
	if _, err := os.Stat(filepath.Join(root, "data")); err != nil {
		t.Skipf("resources not present: %v", err)
	}
	return &server{
		cfg:    config{resourceDir: root, port: "0"},
		eng:    engine.New(root, resolve.DefaultTables()),
		flight: newFlightGroup(),
	}
}

func get(t *testing.T, s *server, h http.HandlerFunc, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func TestImageEndpoint_Still(t *testing.T) {
	s := newTestServer(t)
	rec := get(t, s, s.handleImage, "/image?job=1&gender=male&head=1&frame=0")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("content-type = %q, want image/png", ct)
	}
	if _, err := png.Decode(bytes.NewReader(rec.Body.Bytes())); err != nil {
		t.Errorf("response is not a valid PNG: %v", err)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("missing CORS header")
	}
}

func TestImageEndpoint_MissingJob(t *testing.T) {
	s := newTestServer(t)
	rec := get(t, s, s.handleImage, "/image?gender=male")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// TestImageEndpoint_HeaddirFix verifies the fix end-to-end through the HTTP
// layer: straight and all produce different bytes (the head is pinned vs cycling).
func TestImageEndpoint_HeaddirFix(t *testing.T) {
	s := newTestServer(t)
	straight := get(t, s, s.handleImage, "/image?job=1&gender=male&head=1&action=0&headdir=straight&enableShadow=false")
	all := get(t, s, s.handleImage, "/image?job=1&gender=male&head=1&action=0&headdir=all&enableShadow=false")
	left := get(t, s, s.handleImage, "/image?job=1&gender=male&head=1&action=0&headdir=left&enableShadow=false")
	right := get(t, s, s.handleImage, "/image?job=1&gender=male&head=1&action=0&headdir=right&enableShadow=false")
	for _, r := range []*httptest.ResponseRecorder{straight, all, left, right} {
		if r.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", r.Code, r.Body.String())
		}
	}
	if bytes.Equal(straight.Body.Bytes(), all.Body.Bytes()) {
		t.Error("straight == all (head-direction fix not applied)")
	}
	if bytes.Equal(left.Body.Bytes(), right.Body.Bytes()) {
		t.Error("left == right (head direction not honored)")
	}
}

func TestGifEndpoint(t *testing.T) {
	s := newTestServer(t)
	rec := get(t, s, s.handleGif, "/gif?job=1&gender=male&head=1&action=8")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/gif" {
		t.Errorf("content-type = %q, want image/gif", ct)
	}
	// GIF signature.
	if got := rec.Body.Bytes(); len(got) < 6 || string(got[:3]) != "GIF" {
		t.Error("response is not a GIF")
	}
}

// TestImageDeterministic verifies a render is reproducible: the same query yields
// the same bytes and a stable, immutable ETag (the gateway keeps no disk cache —
// caching is delegated to the browser/CDN via these headers).
func TestImageDeterministic(t *testing.T) {
	s := newTestServer(t)
	target := "/image?job=1&gender=male&head=1&frame=0"
	first := get(t, s, s.handleImage, target)
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d", first.Code)
	}
	second := get(t, s, s.handleImage, target)
	if second.Code != http.StatusOK {
		t.Fatalf("second status = %d", second.Code)
	}
	if !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
		t.Error("re-render produced different bytes for the same query")
	}

	etag := first.Header().Get("Etag")
	if etag == "" {
		t.Fatal("missing ETag header")
	}
	if got := second.Header().Get("Etag"); got != etag {
		t.Errorf("ETag not stable: %q vs %q", etag, got)
	}
	if cc := first.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q, want immutable", cc)
	}
}

// TestImageNotModified verifies a conditional request whose If-None-Match matches
// the render's ETag short-circuits to 304 with an empty body (no re-render).
func TestImageNotModified(t *testing.T) {
	s := newTestServer(t)
	target := "/image?job=1&gender=male&head=1&frame=0"
	first := get(t, s, s.handleImage, target)
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d", first.Code)
	}
	etag := first.Header().Get("Etag")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("If-None-Match", etag)
	s.handleImage(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("304 response has a non-empty body (%d bytes)", rec.Body.Len())
	}
}

// effectsServer builds a server backed by a throwaway effects dir holding one
// effect bundle + a catalogue, so the /effects handler can be exercised without
// the full extracted resources.
func effectsServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "c_spot_light"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(rel, body string) {
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.json", `{"items":[{"id":410127,"name":"Holofote","slots":["mid"],"effect":"c_spot_light"}]}`)
	write("index_en.json", `{"items":[{"id":410127,"name":"Spotlight","slots":["mid"],"effect":"c_spot_light"}]}`)
	write("index_es.json", `{"items":[{"id":410127,"name":"Foco","slots":["mid"],"effect":"c_spot_light"}]}`)
	write("hat_effects.json", `{"items":[{"id":420382,"name":"Escudo Poenitentia","slots":["low"],"effect":"c_spot_light"},{"id":400149,"name":"Aura de Betelgeuse","slots":["mid"],"sprite":"torch_01"}]}`)
	write("hat_effects_en.json", `{"items":[{"id":420382,"name":"Poenitentia Shield","slots":["low"],"effect":"c_spot_light"}]}`)
	write("hat_effects_es.json", `{"items":[{"id":420382,"name":"Escudo Poenitentia","slots":["low"],"effect":"c_spot_light"}]}`)
	write("stones.json", `{"items":[{"id":410127,"effect":"c_spot_light"}]}`)
	write("footprints.json", `{"items":[{"id":1002642,"bottomLeft":"c_spot_light","stride":50}]}`)
	write(filepath.Join("c_spot_light", "effect.json"), `{"key":"c_spot_light","fps":60,"maxKey":150,"layers":[]}`)
	write(filepath.Join("c_spot_light", "tex_0.png"), "\x89PNG\r\n\x1a\n")
	if err := os.MkdirAll(filepath.Join(dir, "sprites", "torch_01"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join("sprites", "torch_01", "sprite.json"), `{"frames":[{"img":"0.png","delay":100,"offset":[0,0]}]}`)
	write(filepath.Join("sprites", "torch_01", "0.png"), "\x89PNG\r\n\x1a\n")
	return &server{cfg: config{effectsDir: dir, port: "0"}, flight: newFlightGroup()}
}

func TestEffectEndpoint(t *testing.T) {
	s := effectsServer(t)
	cases := []struct {
		path string
		code int
		ct   string
	}{
		{"/effects/index.json", http.StatusOK, "application/json"},
		{"/effects/index_en.json", http.StatusOK, "application/json"},
		{"/effects/index_es.json", http.StatusOK, "application/json"},
		{"/effects/index_de.json", http.StatusNotFound, ""},  // valid pattern, locale not extracted
		{"/effects/index_eng.json", http.StatusNotFound, ""}, // not a two-letter locale
		{"/effects/stones_en.json", http.StatusNotFound, ""}, // only index.json is per locale
		{"/effects/hat_effects.json", http.StatusOK, "application/json"},
		{"/effects/hat_effects_en.json", http.StatusOK, "application/json"},
		{"/effects/hat_effects_es.json", http.StatusOK, "application/json"},
		{"/effects/hat_effects_de.json", http.StatusNotFound, ""}, // valid pattern, locale not extracted
		{"/effects/hat_effect.json", http.StatusNotFound, ""},     // not one of the catalogues
		{"/effects/stones.json", http.StatusOK, "application/json"},
		{"/effects/footprints.json", http.StatusOK, "application/json"},
		{"/effects/other.json", http.StatusNotFound, ""}, // only the catalogues are served bare
		{"/effects/c_spot_light/effect.json", http.StatusOK, "application/json"},
		{"/effects/c_spot_light/tex_0.png", http.StatusOK, "image/png"},
		{"/effects/c_spot_light/tex_9.png", http.StatusNotFound, ""},       // valid pattern, no such file
		{"/effects/nope/effect.json", http.StatusNotFound, ""},             // unknown key
		{"/effects/c_spot_light/secret.txt", http.StatusNotFound, ""},      // disallowed filename
		{"/effects/c_spot_light", http.StatusNotFound, ""},                 // missing file segment
		{"/effects/c_spot_light/sub/effect.json", http.StatusNotFound, ""}, // too many segments
		{"/effects/sprites/torch_01/sprite.json", http.StatusOK, "application/json"},
		{"/effects/sprites/torch_01/0.png", http.StatusOK, "image/png"},
		{"/effects/sprites/torch_01/9.png", http.StatusNotFound, ""},       // valid pattern, no such frame
		{"/effects/sprites/torch_01/effect.json", http.StatusNotFound, ""}, // wrong file for a sprite bundle
		{"/effects/sprites/torch_01", http.StatusNotFound, ""},             // missing file segment
		{"/effects/sprites/torch_01/sub/0.png", http.StatusNotFound, ""},   // too many segments
	}
	for _, c := range cases {
		rec := get(t, s, s.handleEffect, c.path)
		if rec.Code != c.code {
			t.Errorf("%s: status = %d, want %d", c.path, rec.Code, c.code)
		}
		if c.code == http.StatusOK {
			if ct := rec.Header().Get("Content-Type"); ct != c.ct {
				t.Errorf("%s: content-type = %q, want %q", c.path, ct, c.ct)
			}
			if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Errorf("%s: missing CORS header", c.path)
			}
		}
	}
}

// TestEffectTraversal makes sure the strict key/filename patterns reject path
// traversal even when the raw request path contains "..".
func TestEffectTraversal(t *testing.T) {
	s := effectsServer(t)
	for _, p := range []string{
		"/effects/../index.json",
		"/effects/c_spot_light/..%2feffect.json",
		"/effects/..%2f..%2fmain.go",
	} {
		rec := httptest.NewRecorder()
		s.handleEffect(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, rec.Code)
		}
	}
}

// TestResolveMapPath exercises the /maps path whitelist directly: the accepted
// shapes (catalogue, shared blob, per-map geometry/manifest) and the rejections
// that keep traversal and cross-store mismatches structurally impossible.
func TestResolveMapPath(t *testing.T) {
	ok := []struct{ in, want string }{
		{"index.json", "index.json"},
		{"prontera/manifest.json", "prontera/manifest.json"},
		{"prontera/prontera.gat", "prontera/prontera.gat"},
		{"prontera/prontera.gnd", "prontera/prontera.gnd"},
		{"prontera/prontera.rsw", "prontera/prontera.rsw"},
		{"1@cata/1@cata.gat", "1@cata/1@cata.gat"}, // instance map slug (@)
		{"_t/0123456789abcdef.png", "_t/0123456789abcdef.png"},
		{"_m/0123456789abcdef.rsm", "_m/0123456789abcdef.rsm"},
		{"_w/0123456789abcdef.jpg", "_w/0123456789abcdef.jpg"},
		{"_u/0123456789abcdef.png", "_u/0123456789abcdef.png"},
	}
	for _, c := range ok {
		got, valid := resolveMapPath(c.in)
		if !valid || got != c.want {
			t.Errorf("resolveMapPath(%q) = (%q, %v), want (%q, true)", c.in, got, valid, c.want)
		}
	}

	bad := []string{
		"prontera/secret.txt",         // disallowed filename
		"prontera/iz_int.gat",         // geometry name must match the map dir
		"prontera",                    // missing file segment
		"prontera/sub/manifest.json",  // too many segments
		"prontera/../_t/x.png",        // traversal
		"Prontera/manifest.json",      // uppercase slug
		"_t/0123456789abcdef.rsm",     // right store, wrong extension
		"_m/0123456789abcdef.png",     // wrong extension for store
		"_x/0123456789abcdef.png",     // unknown store
		"_t/notahexhash.png",          // bad hash
		"_t/0123456789abcdef0.png",    // 17-char hash
		"index.json/../../etc/passwd", // traversal off the catalogue
	}
	for _, in := range bad {
		if got, valid := resolveMapPath(in); valid {
			t.Errorf("resolveMapPath(%q) = (%q, true), want invalid", in, got)
		}
	}
}

// soundsServer builds a server over a throwaway sound tree that mirrors the
// shapes extract-grf.mjs --sounds produces: an ASCII effect sound, a bare-name
// sound, and a Korean sound stored under its decoded UTF-8 (Hangul) name — the
// last exercises the EUC-KR reinterpretation the resolver does for names the
// effect table carries as raw EUC-KR bytes.
func soundsServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, body string) {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("effect/ef_portal.wav", "RIFFfake-wav-portal")
	write("_heal_effect.wav", "RIFFfake-wav-heal")
	write("effect/흡기.wav", "RIFFfake-wav-heupgi") // table asks for it as "effect/Èí±â"
	write("index.json", `{"count":3,"names":["_heal_effect","effect/ef_portal","effect/흡기"]}`)
	return &server{cfg: config{soundsDir: dir, port: "0"}, flight: newFlightGroup()}
}

func TestSoundEndpoint(t *testing.T) {
	s := soundsServer(t)
	cases := []struct {
		path string
		code int
		ct   string
	}{
		{"/effect/sound?file=effect/ef_portal", http.StatusOK, "audio/wav"},
		{"/effect/sound?file=_heal_effect", http.StatusOK, "audio/wav"},
		{"/effect/sound?file=effect/ef_portal.wav", http.StatusOK, "audio/wav"}, // stray extension tolerated
		{"/effect/sound?file=EFFECT/EF_PORTAL", http.StatusOK, "audio/wav"},     // case folded
		{"/effect/sound?file=effect/Èí±â", http.StatusOK, "audio/wav"},          // EUC-KR mojibake → Hangul
		{"/effect/sound/index.json", http.StatusOK, "application/json"},
		{"/effect/sound?file=effect/does_not_exist", http.StatusNotFound, ""}, // absent, not 500
		{"/effect/sound?file=effect/", http.StatusNotFound, ""},               // degenerate empty basename
		{"/effect/sound", http.StatusBadRequest, ""},                          // missing file param
	}
	for _, c := range cases {
		rec := get(t, s, s.handleEffectAsset, c.path)
		if rec.Code != c.code {
			t.Errorf("%s: status = %d, want %d", c.path, rec.Code, c.code)
		}
		if c.code == http.StatusOK {
			if ct := rec.Header().Get("Content-Type"); ct != c.ct {
				t.Errorf("%s: content-type = %q, want %q", c.path, ct, c.ct)
			}
			if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Errorf("%s: missing CORS header", c.path)
			}
			if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
				t.Errorf("%s: cache-control = %q, want immutable", c.path, cc)
			}
		}
	}
}

// TestSoundTraversal confirms the resolver can't be walked out of the sound tree.
func TestSoundTraversal(t *testing.T) {
	s := soundsServer(t)
	for _, p := range []string{
		"/effect/sound?file=../main.go",
		"/effect/sound?file=effect/../../main.go",
		"/effect/sound?file=/etc/passwd",
		"/effect/sound?file=effect/..%2f..%2fmain.go",
		"/effect/sound?file=..\\..\\main.go",
	} {
		rec := get(t, s, s.handleEffectAsset, p)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, rec.Code)
		}
	}
}

func bgmServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, body string) {
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.json", `{"maps":{"prontera":"210.mp3"}}`)
	write("210.mp3", "ID3fake-mp3-bytes")
	return &server{cfg: config{bgmDir: dir, port: "0"}, flight: newFlightGroup()}
}

func TestBgmEndpoint(t *testing.T) {
	s := bgmServer(t)
	cases := []struct {
		path string
		code int
		ct   string
	}{
		{"/bgm/index.json", http.StatusOK, "application/json"},
		{"/bgm/210.mp3", http.StatusOK, "audio/mpeg"},
		{"/bgm/999.mp3", http.StatusNotFound, ""},     // valid pattern, no such track
		{"/bgm/secret.txt", http.StatusNotFound, ""},  // disallowed extension
		{"/bgm/sub/210.mp3", http.StatusNotFound, ""}, // nested path
		{"/bgm/", http.StatusNotFound, ""},            // empty
	}
	for _, c := range cases {
		rec := get(t, s, s.handleBgm, c.path)
		if rec.Code != c.code {
			t.Errorf("%s: status = %d, want %d", c.path, rec.Code, c.code)
		}
		if c.code == http.StatusOK {
			if ct := rec.Header().Get("Content-Type"); ct != c.ct {
				t.Errorf("%s: content-type = %q, want %q", c.path, ct, c.ct)
			}
			if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Errorf("%s: missing CORS header", c.path)
			}
		}
	}
}

// TestBgmTraversal confirms the strict track-name pattern rejects path traversal
// even when the raw request path contains "..".
func TestBgmTraversal(t *testing.T) {
	s := bgmServer(t)
	for _, p := range []string{
		"/bgm/../index.json",
		"/bgm/..%2f..%2fmain.go",
		"/bgm/%2e%2e/210.mp3",
	} {
		rec := get(t, s, s.handleBgm, p)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, rec.Code)
		}
	}
}

func rawServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, body string) {
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("mobs.json", `{"1002":{"name":"Poring"}}`)
	write("mobs_es.json", `{"1002":{"name":"Poring"}}`)
	write("items.json", `{"501":{"name":"Red Potion"}}`)
	write("items_en.json", `{"501":{"name":"Red Potion"}}`)
	write("secret.txt", "not json, not served")
	return &server{cfg: config{rawDir: dir, port: "0"}, flight: newFlightGroup()}
}

func TestRawEndpoint(t *testing.T) {
	s := rawServer(t)
	cases := []struct {
		path string
		code int
		ct   string
	}{
		{"/raw/mobs.json", http.StatusOK, "application/json"},
		{"/raw/items.json", http.StatusOK, "application/json"},
		{"/raw/items_en.json", http.StatusOK, "application/json"}, // a locale's copy of a table
		{"/raw/mobs_es.json", http.StatusOK, "application/json"},  // monster names in Spanish
		{"/raw/items_es.json", http.StatusNotFound, ""},           // valid pattern, locale not extracted
		{"/raw/skills.json", http.StatusNotFound, ""},             // valid pattern, no such table
		{"/raw/secret.txt", http.StatusNotFound, ""},              // disallowed extension
		{"/raw/sub/mobs.json", http.StatusNotFound, ""},           // nested path
		{"/raw/", http.StatusNotFound, ""},                        // empty
		{"/raw/Mobs.json", http.StatusNotFound, ""},               // uppercase
		{"/raw/_mobs.json", http.StatusNotFound, ""},              // leading underscore
	}
	for _, c := range cases {
		rec := get(t, s, s.handleRaw, c.path)
		if rec.Code != c.code {
			t.Errorf("%s: status = %d, want %d", c.path, rec.Code, c.code)
		}
		if c.code == http.StatusOK {
			if ct := rec.Header().Get("Content-Type"); ct != c.ct {
				t.Errorf("%s: content-type = %q, want %q", c.path, ct, c.ct)
			}
			if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Errorf("%s: missing CORS header", c.path)
			}
		}
	}
}

// TestRawTraversal confirms the strict table-name pattern rejects path traversal
// even when the raw request path contains "..".
func TestRawTraversal(t *testing.T) {
	s := rawServer(t)
	for _, p := range []string{
		"/raw/../main.go",
		"/raw/..%2f..%2fmain.go",
		"/raw/%2e%2e/mobs.json",
	} {
		rec := get(t, s, s.handleRaw, p)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, rec.Code)
		}
	}
}

// TestRawCacheHeaders pins the one thing /raw must not inherit from the other
// asset handlers: these files are regenerated in place after a client update, so
// they must revalidate rather than be pinned as immutable for a year.
func TestRawCacheHeaders(t *testing.T) {
	s := rawServer(t)
	rec := get(t, s, s.handleRaw, "/raw/mobs.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	cc := rec.Header().Get("Cache-Control")
	if strings.Contains(cc, "immutable") {
		t.Errorf("cache-control = %q, must not be immutable", cc)
	}
	if !strings.Contains(cc, "must-revalidate") {
		t.Errorf("cache-control = %q, want must-revalidate", cc)
	}
	etag := rec.Header().Get("Etag")
	if etag == "" {
		t.Error("missing ETag")
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("missing CORS header")
	}

	// A conditional revalidation must answer 304 and repeat the same short-lived
	// policy — a 304 carrying "immutable" would defeat the point.
	req := httptest.NewRequest(http.MethodGet, "/raw/mobs.json", nil)
	req.Header.Set("If-None-Match", etag)
	cond := httptest.NewRecorder()
	s.handleRaw(cond, req)
	if cond.Code != http.StatusNotModified {
		t.Fatalf("conditional status = %d, want 304", cond.Code)
	}
	if got := cond.Header().Get("Cache-Control"); got != cc {
		t.Errorf("304 cache-control = %q, want %q", got, cc)
	}
	if cond.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("304: missing CORS header")
	}
}

// TestImmutableAssetsUnchanged guards the /raw cache-policy refactor: the
// content-addressed handlers must still emit the long-lived immutable policy.
func TestImmutableAssetsUnchanged(t *testing.T) {
	s := bgmServer(t)
	for _, p := range []string{"/bgm/index.json", "/bgm/210.mp3"} {
		rec := get(t, s, s.handleBgm, p)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", p, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Errorf("%s: cache-control = %q, want the immutable policy", p, cc)
		}
	}
}

func illustServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "card"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "card", "4001.png"), []byte("\x89PNG\r\n\x1a\nfake"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &server{cfg: config{illustDir: dir, port: "0"}, flight: newFlightGroup()}
}

func TestIllustEndpoint(t *testing.T) {
	s := illustServer(t)
	cases := []struct {
		path string
		code int
	}{
		{"/illust/card/4001.png", http.StatusOK},
		{"/illust/card/9999.png", http.StatusNotFound},     // valid pattern, no such card
		{"/illust/item/4001.png", http.StatusNotFound},     // not an illust kind
		{"/illust/card/4001.bmp", http.StatusNotFound},     // disallowed extension
		{"/illust/card/sub/4001.png", http.StatusNotFound}, // nested path
		{"/illust/4001.png", http.StatusNotFound},          // no kind
		{"/illust/card/", http.StatusNotFound},             // empty name
	}
	for _, c := range cases {
		rec := get(t, s, s.handleIllust, c.path)
		if rec.Code != c.code {
			t.Errorf("%s: status = %d, want %d", c.path, rec.Code, c.code)
		}
		if c.code == http.StatusOK {
			if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
				t.Errorf("%s: content-type = %q, want image/png", c.path, ct)
			}
			if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Errorf("%s: missing CORS header", c.path)
			}
		}
	}
}

// TestIllustTraversal confirms the kind whitelist plus filename pattern reject
// path traversal even when the raw request path contains "..".
func TestIllustTraversal(t *testing.T) {
	s := illustServer(t)
	for _, p := range []string{
		"/illust/../main.go",
		"/illust/card/..%2f..%2fmain.go",
		"/illust/%2e%2e/card/4001.png",
	} {
		rec := get(t, s, s.handleIllust, p)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, rec.Code)
		}
	}
}

// Every non-2xx this server writes must carry a cache policy and no validator.
//
// These paths deliberately avoid newTestServer: they must run in CI, where the
// resources tree is absent and every resource-backed test skips. An error-header
// regression that only showed up on a machine with 15 GB of extracted client
// would be a regression nobody sees.
func TestErrorResponsesCarryACachePolicy(t *testing.T) {
	s := &server{}

	t.Run("404 revalidates", func(t *testing.T) {
		rec := get(t, s, s.handleRoot, "/no-such-path")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != api.CacheRevalidate {
			t.Errorf("Cache-Control = %q, want %q", cc, api.CacheRevalidate)
		}
		if et := rec.Header().Get("Etag"); et != "" {
			t.Errorf("404 carried a validator: %q", et)
		}
	})

	t.Run("error is not stored", func(t *testing.T) {
		rec := httptest.NewRecorder()
		s.handleImage(rec, httptest.NewRequest(http.MethodPost, "/image?job=1", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != api.CacheNoStore {
			t.Errorf("Cache-Control = %q, want %q", cc, api.CacheNoStore)
		}
	})

	// The bug the helpers exist to prevent: a handler that stamped the asset
	// headers and then failed. Without the Del, the error is stored as immutable
	// under a query-derived ETag, revalidates to 304 against that same query, and
	// the image stays broken until the client bypasses its own cache.
	t.Run("stale asset headers are cleared", func(t *testing.T) {
		rec := httptest.NewRecorder()
		api.SetAssetHeaders(rec, "deadbeef", api.CacheImmutable)
		failWith(rec, "render failed", http.StatusInternalServerError)
		if et := rec.Header().Get("Etag"); et != "" {
			t.Errorf("failed render kept its validator: %q", et)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != api.CacheNoStore {
			t.Errorf("Cache-Control = %q, want %q", cc, api.CacheNoStore)
		}
	})
}

// effectStrServer serves a single synthetic .str out of a temp data/texture/effect
// tree, so the /effect/str handler can be exercised without the client's GRF.
func effectStrServer(t *testing.T, name string, body []byte) *server {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "data", "texture", "effect", filepath.FromSlash(name)+".str")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatal(err)
	}
	return &server{
		cfg:    config{resourceDir: dir, port: "0"},
		estore: effect.NewStore(dir),
		flight: newFlightGroup(),
	}
}

// nonFiniteStr builds a one-layer, one-keyframe STRM carrying +Inf in pos[1],
// -Inf in xy[0] and NaN in angle — the shape of the 4th-job *_bottom ground
// layers that used to 500 with "parse failed: json: unsupported value: +Inf".
func nonFiniteStr() []byte {
	var b bytes.Buffer
	u32 := func(v uint32) { binary.Write(&b, binary.LittleEndian, v) }
	f32 := func(v float32) { u32(math.Float32bits(v)) }

	b.WriteString("STRM")
	u32(0x94)                 // version
	u32(60)                   // fps
	u32(100)                  // maxKey
	u32(1)                    // layerCount
	b.Write(make([]byte, 16)) // reserved

	u32(1) // textureCount
	field := make([]byte, 128)
	copy(field, "ring_bottom.bmp")
	b.Write(field)

	u32(1)                                          // animCount
	binary.Write(&b, binary.LittleEndian, int32(0)) // frame
	u32(0)                                          // type
	f32(1.5)                                        // pos[0]
	f32(float32(math.Inf(1)))                       // pos[1]
	for i := 0; i < 8; i++ {
		f32(float32(i)) // uv
	}
	f32(float32(math.Inf(-1))) // xy[0]
	for i := 1; i < 8; i++ {
		f32(float32(10 + i)) // xy[1..7]
	}
	f32(0.75)                // aniframe
	u32(0)                   // anitype
	f32(4.0)                 // delay
	f32(float32(math.NaN())) // angle
	f32(255)                 // color r
	f32(128)                 // color g
	f32(64)                  // color b
	f32(255)                 // color a
	u32(5)                   // srcalpha
	u32(2)                   // destalpha
	u32(7)                   // mtpreset
	return b.Bytes()
}

// TestEffectStrNonFinite pins that a .str with non-finite keyframe floats serves
// 200 with usable JSON instead of 500, and that the response shape the replay
// viewer parses — {fps, maxKey, layers:[{textures, animations:[...]}]} — is
// unchanged, with the offending fields zeroed.
func TestEffectStrNonFinite(t *testing.T) {
	s := effectStrServer(t, "rockdown/rockdown_bottom/rockdown_bottom", nonFiniteStr())

	rec := get(t, s, s.handleEffectAsset, "/effect/str?file=rockdown/rockdown_bottom/rockdown_bottom")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q, want application/json", ct)
	}

	raw := rec.Body.Bytes()
	if bytes.Contains(raw, []byte("Inf")) || bytes.Contains(raw, []byte("NaN")) {
		t.Errorf("body carries a non-finite literal: %s", raw)
	}
	var got struct {
		FPS    uint32 `json:"fps"`
		MaxKey uint32 `json:"maxKey"`
		Layers []struct {
			Textures   []string `json:"textures"`
			Animations []struct {
				Pos   [2]float32 `json:"pos"`
				XY    [8]float32 `json:"xy"`
				Angle float32    `json:"angle"`
				Color [4]float32 `json:"color"`
			} `json:"animations"`
		} `json:"layers"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("body is not valid JSON: %v (%s)", err, raw)
	}
	if got.FPS != 60 || got.MaxKey != 100 {
		t.Errorf("header: fps=%d maxKey=%d, want 60/100", got.FPS, got.MaxKey)
	}
	if len(got.Layers) != 1 || len(got.Layers[0].Animations) != 1 {
		t.Fatalf("layer/keyframe dropped: %#v", got.Layers)
	}
	if n := got.Layers[0].Textures; len(n) != 1 || n[0] != "ring_bottom.bmp" {
		t.Errorf("textures = %#v", n)
	}
	k := got.Layers[0].Animations[0]
	if k.Pos != [2]float32{1.5, 0} {
		t.Errorf("pos = %v, want [1.5 0]", k.Pos)
	}
	if k.XY != [8]float32{0, 11, 12, 13, 14, 15, 16, 17} {
		t.Errorf("xy = %v, want [0 11 12 13 14 15 16 17]", k.XY)
	}
	if k.Angle != 0 {
		t.Errorf("angle = %v, want 0", k.Angle)
	}
	if k.Color != [4]float32{255, 128, 64, 255} {
		t.Errorf("color = %v, want [255 128 64 255]", k.Color)
	}
}

// TestCORSOnEveryResponse drives the real routing chain (s.handler(), the same
// value main gives http.Server) rather than a handler in isolation, because the
// wrapper is where the header now comes from.
//
// It is the regression test for the failure that motivated the middleware: a
// browser asking for an asset this client never shipped got
//
//	Access to fetch at '…/effect/sound?file=holyhit' from origin
//	'http://localhost:5173' has been blocked by CORS policy: No
//	'Access-Control-Allow-Origin' header is present on the requested resource.
//
// instead of the plain 404 it handles by drawing nothing. The four sound names
// below are real misses against the LATAM client, and `/effect/str` without a
// `file` is the 400 arm.
func TestCORSOnEveryResponse(t *testing.T) {
	root := t.TempDir()
	sounds := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data", "texture", "effect"), 0o755); err != nil {
		t.Fatal(err)
	}
	// One sound that does exist, so the 200 arm goes down the same chain.
	if err := os.WriteFile(filepath.Join(sounds, "present.wav"), []byte("RIFF\x00\x00\x00\x00WAVE"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &server{
		cfg:    config{resourceDir: root, soundsDir: sounds, port: "0"},
		estore: effect.NewStore(root),
		flight: newFlightGroup(),
	}
	h := s.handler()

	cases := []struct {
		target string
		want   int
	}{
		{"/effect/sound?file=present", http.StatusOK},
		{"/effect/sound?file=holyhit", http.StatusNotFound},
		{"/effect/sound?file=cwound", http.StatusNotFound},
		{"/effect/sound?file=melt", http.StatusNotFound},
		{"/effect/sound?file=maximizepower", http.StatusNotFound},
		{"/effect/sound", http.StatusBadRequest},
		{"/effect/texture?file=new_abr_mother/abr_mother.tga", http.StatusNotFound},
		{"/effect/str", http.StatusBadRequest},
		{"/effect/nope", http.StatusNotFound},
		{"/no/such/route", http.StatusNotFound},
		{"/healthz", http.StatusOK},
		{"/", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.target, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tc.target, nil)
			req.Header.Set("Origin", "http://localhost:5173")
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.want, rec.Body.String())
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("Access-Control-Allow-Origin = %q, want %q — a browser reports this as a CORS failure, not as %d", got, "*", tc.want)
			}
		})
	}
}

// TestCORSOnMethodNotAllowed covers the one error arm no GET can reach.
func TestCORSOnMethodNotAllowed(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data", "texture", "effect"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := &server{
		cfg:    config{resourceDir: root, port: "0"},
		estore: effect.NewStore(root),
		flight: newFlightGroup(),
	}
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/effect/str?file=x", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, "*")
	}
}
