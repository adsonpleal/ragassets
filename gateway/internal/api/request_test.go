package api

import (
	"net/http/httptest"
	"testing"
)

// A handler may stamp the asset headers and only then hit the path that fails.
// What must never survive that is the validator: these ETags hash the query
// rather than the bytes, so an error that keeps one still matches on the next
// request, the origin answers 304, and the browser re-serves the error body.
// That is what made a transient render failure a permanently broken image.
func TestErrorHeadersCannotBeRevalidated(t *testing.T) {
	for _, tc := range []struct {
		name         string
		apply        func(w *httptest.ResponseRecorder)
		cacheControl string
	}{
		{"error", func(w *httptest.ResponseRecorder) { SetErrorHeaders(w) }, CacheNoStore},
		{"missing", func(w *httptest.ResponseRecorder) { SetMissingHeaders(w) }, CacheRevalidate},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			SetAssetHeaders(w, "abc123", CacheImmutable)
			tc.apply(w)

			if got := w.Header().Get("Etag"); got != "" {
				t.Errorf("ETag survived: %q — a cached copy of this could revalidate into a 304", got)
			}
			if got := w.Header().Get("Cache-Control"); got != tc.cacheControl {
				t.Errorf("Cache-Control = %q, want %q", got, tc.cacheControl)
			}
		})
	}
}

func TestAssetHeaders(t *testing.T) {
	w := httptest.NewRecorder()
	SetAssetHeaders(w, "abc123", CacheImmutable)

	if got, want := w.Header().Get("Etag"), `"abc123"`; got != want {
		t.Errorf("ETag = %q, want %q (quoted, per RFC 9110)", got, want)
	}
	if got := w.Header().Get("Cache-Control"); got != CacheImmutable {
		t.Errorf("Cache-Control = %q, want %q", got, CacheImmutable)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("CORS header = %q, want %q", got, "*")
	}
}
