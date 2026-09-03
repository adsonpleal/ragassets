package main

import (
	"bytes"
	"net/http"
	"net/url"
	"testing"

	"github.com/ragassets/gateway/internal/api"
	"github.com/ragassets/gateway/internal/render/raster"
)

func TestBuildRequest_Skin(t *testing.T) {
	brown := raster.Color{R: 0xc9, G: 0xa0, B: 0x7f, A: 0xFF}
	cases := []struct {
		query     string
		wantTone  int
		wantColor *raster.Color
		wantErr   bool
	}{
		{query: "job=1", wantTone: 1},
		{query: "job=1&skinTone=1", wantTone: 1},
		{query: "job=1&skinTone=4", wantTone: 4},
		{query: "job=1&skinTone=default", wantTone: 1},
		{query: "job=1&skinColor=c9a07f", wantTone: 1, wantColor: &brown},
		{query: "job=1&skinColor=%23c9a07f", wantTone: 1, wantColor: &brown},
		{query: "job=1&skinColor=C9A07F", wantTone: 1, wantColor: &brown},
		{query: "job=1&skinTone=0", wantErr: true},
		{query: "job=1&skinTone=5", wantErr: true},
		{query: "job=1&skinTone=abc", wantErr: true},
		{query: "job=1&skinColor=xyz", wantErr: true},
		{query: "job=1&skinColor=c9a", wantErr: true}, // shorthand is not accepted
		{query: "job=1&skinColor=c9a07fff", wantErr: true},
		{query: "job=1&skinTone=2&skinColor=c9a07f", wantErr: true},
	}
	for _, tc := range cases {
		q, err := url.ParseQuery(tc.query)
		if err != nil {
			t.Fatalf("bad test query %q: %v", tc.query, err)
		}
		req, _, err := api.BuildRequest(q)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: expected an error, got none", tc.query)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", tc.query, err)
			continue
		}
		if req.SkinTone != tc.wantTone {
			t.Errorf("%s: SkinTone = %d, want %d", tc.query, req.SkinTone, tc.wantTone)
		}
		switch {
		case tc.wantColor == nil && req.SkinColor != nil:
			t.Errorf("%s: SkinColor = %+v, want nil", tc.query, *req.SkinColor)
		case tc.wantColor != nil && req.SkinColor == nil:
			t.Errorf("%s: SkinColor = nil, want %+v", tc.query, *tc.wantColor)
		case tc.wantColor != nil && *req.SkinColor != *tc.wantColor:
			t.Errorf("%s: SkinColor = %+v, want %+v", tc.query, *req.SkinColor, *tc.wantColor)
		}
	}
}

func TestImageEndpoint_Skin(t *testing.T) {
	s := newTestServer(t)
	const base = "/image?job=1&gender=male&head=1&frame=0&enableShadow=false"

	plain := get(t, s, s.handleImage, base)
	if plain.Code != http.StatusOK {
		t.Fatalf("baseline status = %d: %s", plain.Code, plain.Body.String())
	}
	identity := get(t, s, s.handleImage, base+"&skinTone=1")
	if !bytes.Equal(plain.Body.Bytes(), identity.Body.Bytes()) {
		t.Error("skinTone=1 is not byte-identical to omitting the param")
	}
	toned := get(t, s, s.handleImage, base+"&skinTone=4")
	if toned.Code != http.StatusOK {
		t.Fatalf("skinTone=4 status = %d: %s", toned.Code, toned.Body.String())
	}
	if bytes.Equal(plain.Body.Bytes(), toned.Body.Bytes()) {
		t.Error("skinTone=4 produced identical bytes to the default")
	}
	custom := get(t, s, s.handleImage, base+"&skinColor=8a5a3b")
	if custom.Code != http.StatusOK {
		t.Fatalf("skinColor status = %d: %s", custom.Code, custom.Body.String())
	}
	if bytes.Equal(custom.Body.Bytes(), toned.Body.Bytes()) {
		t.Error("a custom colour produced the same bytes as preset 4")
	}

	// A distinct tone must get a distinct ETag, or a CDN would serve the wrong one.
	if plain.Header().Get("Etag") == toned.Header().Get("Etag") {
		t.Error("skinTone did not change the ETag")
	}

	for _, bad := range []string{"&skinTone=9", "&skinColor=nope", "&skinTone=2&skinColor=8a5a3b"} {
		if rec := get(t, s, s.handleImage, base+bad); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", bad, rec.Code)
		}
	}
}
