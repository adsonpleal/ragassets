package main

import (
	"bytes"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ragassets/zrenderer-gateway/internal/render/engine"
	"github.com/ragassets/zrenderer-gateway/internal/render/resolve"
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
		{"/effects/c_spot_light/effect.json", http.StatusOK, "application/json"},
		{"/effects/c_spot_light/tex_0.png", http.StatusOK, "image/png"},
		{"/effects/c_spot_light/tex_9.png", http.StatusNotFound, ""},       // valid pattern, no such file
		{"/effects/nope/effect.json", http.StatusNotFound, ""},             // unknown key
		{"/effects/c_spot_light/secret.txt", http.StatusNotFound, ""},      // disallowed filename
		{"/effects/c_spot_light", http.StatusNotFound, ""},                 // missing file segment
		{"/effects/c_spot_light/sub/effect.json", http.StatusNotFound, ""}, // too many segments
		{"/effects/sprites/torch_01/sprite.json", http.StatusOK, "application/json"},
		{"/effects/sprites/torch_01/0.png", http.StatusOK, "image/png"},
		{"/effects/sprites/torch_01/9.png", http.StatusNotFound, ""},        // valid pattern, no such frame
		{"/effects/sprites/torch_01/effect.json", http.StatusNotFound, ""},  // wrong file for a sprite bundle
		{"/effects/sprites/torch_01", http.StatusNotFound, ""},              // missing file segment
		{"/effects/sprites/torch_01/sub/0.png", http.StatusNotFound, ""},    // too many segments
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
		"prontera/secret.txt",            // disallowed filename
		"prontera/iz_int.gat",            // geometry name must match the map dir
		"prontera",                       // missing file segment
		"prontera/sub/manifest.json",     // too many segments
		"prontera/../_t/x.png",           // traversal
		"Prontera/manifest.json",         // uppercase slug
		"_t/0123456789abcdef.rsm",        // right store, wrong extension
		"_m/0123456789abcdef.png",        // wrong extension for store
		"_x/0123456789abcdef.png",        // unknown store
		"_t/notahexhash.png",             // bad hash
		"_t/0123456789abcdef0.png",       // 17-char hash
		"index.json/../../etc/passwd",    // traversal off the catalogue
	}
	for _, in := range bad {
		if got, valid := resolveMapPath(in); valid {
			t.Errorf("resolveMapPath(%q) = (%q, true), want invalid", in, got)
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
		{"/bgm/999.mp3", http.StatusNotFound, ""},   // valid pattern, no such track
		{"/bgm/secret.txt", http.StatusNotFound, ""}, // disallowed extension
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
