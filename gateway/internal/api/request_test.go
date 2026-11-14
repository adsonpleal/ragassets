package api

import (
	"net/http"
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

// TestAllowCORSOnAnyStatus pins the half of the CORS contract that was missing:
// the header is on the response whatever the handler does with it. A handler
// that writes an error — or writes nothing at all — still gets it, because the
// middleware stamps the header map on the way in.
func TestAllowCORSOnAnyStatus(t *testing.T) {
	cases := []struct {
		name string
		h    http.HandlerFunc
		want int
	}{
		{"200", func(w http.ResponseWriter, r *http.Request) {
			SetAssetHeaders(w, "abc123", CacheImmutable)
			w.Write([]byte("ok"))
		}, http.StatusOK},
		{"404", func(w http.ResponseWriter, r *http.Request) {
			SetMissingHeaders(w)
			http.NotFound(w, r)
		}, http.StatusNotFound},
		{"500", func(w http.ResponseWriter, r *http.Request) {
			SetErrorHeaders(w)
			http.Error(w, "render failed", http.StatusInternalServerError)
		}, http.StatusInternalServerError},
		{"400", func(w http.ResponseWriter, r *http.Request) {
			SetErrorHeaders(w)
			http.Error(w, "missing 'file' query parameter", http.StatusBadRequest)
		}, http.StatusBadRequest},
		{"304", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotModified)
		}, http.StatusNotModified},
		{"implicit 200, no headers set", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("hi"))
		}, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			AllowCORS(tc.h).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d", w.Code, tc.want)
			}
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("CORS header = %q, want %q", got, "*")
			}
		})
	}
}

// TestAllowCORSNoCredentials guards the one thing that would make the wildcard
// illegal: a browser rejects `Access-Control-Allow-Origin: *` outright when the
// response also allows credentials. Every route here is public and
// unauthenticated, and nothing may quietly add that header.
func TestAllowCORSNoCredentials(t *testing.T) {
	w := httptest.NewRecorder()
	AllowCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want it unset beside a wildcard origin", got)
	}
}
