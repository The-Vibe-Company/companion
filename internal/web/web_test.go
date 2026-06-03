package web

import (
	"html/template"
	"io/fs"
	"strings"
	"testing"
)

// TestIndexTemplateRenders guards the contract between the Go handler and the
// embedded index.html: it must stay a parseable template that injects the
// workspace name and refresh interval, and must keep referencing the served
// asset paths. A stray "{{" in the markup or a renamed placeholder would break
// the dashboard at runtime; this keeps it failing in CI instead.
func TestIndexTemplateRenders(t *testing.T) {
	tpl, err := template.ParseFS(assets, "assets/index.html")
	if err != nil {
		t.Fatalf("parse index.html template: %v", err)
	}

	var sb strings.Builder
	if err := tpl.Execute(&sb, map[string]any{
		"Workspace":   "test-workspace",
		"IntervalSec": 30,
	}); err != nil {
		t.Fatalf("execute index.html template: %v", err)
	}
	out := sb.String()

	for _, want := range []string{
		`data-interval="30"`,
		`data-workspace="test-workspace"`,
		`/assets/dashboard.css`,
		`/assets/dashboard.js`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered index.html missing %q", want)
		}
	}
}

// TestEmbeddedAssetsPresent ensures the three frontend files the dashboard
// serves are actually embedded and non-empty, so go:embed cannot silently ship
// a stylesheet-less or script-less build.
func TestEmbeddedAssetsPresent(t *testing.T) {
	for _, name := range []string{
		"assets/index.html",
		"assets/dashboard.css",
		"assets/dashboard.js",
	} {
		data, err := fs.ReadFile(assets, name)
		if err != nil {
			t.Errorf("embedded asset %s: %v", name, err)
			continue
		}
		if len(data) == 0 {
			t.Errorf("embedded asset %s is empty", name)
		}
	}
}
