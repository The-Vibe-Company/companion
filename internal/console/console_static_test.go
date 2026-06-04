package console

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// TestStaticAssetHandlerServesNestedViteBundle guards the embed path mapping.
// bin/build-console-ui syncs the Vite dist into internal/console/assets as an
// index.html beside a nested assets/ directory, and NewServer roots the served
// FS at that mirror via fs.Sub(assets, "assets"). The SPA requests its bundle at
// /assets/<hash>.{js,css}; the handler must resolve that onto the nested assets/
// subtree. A StripPrefix("/assets/") here would drop that directory and 404
// every bundle (a blank page in the browser), so this asserts the real wiring.
func TestStaticAssetHandlerServesNestedViteBundle(t *testing.T) {
	mirror := fstest.MapFS{
		"index.html":              {Data: []byte("<!doctype html>")},
		"assets/index-abc123.js":  {Data: []byte("export const x = 1")},
		"assets/index-abc123.css": {Data: []byte(".x{}")},
	}

	mux := http.NewServeMux()
	mux.Handle("GET /assets/", staticAssetHandler(mirror))

	cases := []struct {
		path string
		want string
	}{
		{"/assets/index-abc123.js", "export const x = 1"},
		{"/assets/index-abc123.css", ".x{}"},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200 (nested /assets bundle must serve)", tc.path, rec.Code)
			}
			if got := rec.Body.String(); got != tc.want {
				t.Fatalf("GET %s body = %q, want %q", tc.path, got, tc.want)
			}
		})
	}

	// A path that does not exist in the mirror must still 404 cleanly.
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /assets/missing.js = %d, want 404", rec.Code)
	}
}
