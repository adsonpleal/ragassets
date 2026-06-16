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
