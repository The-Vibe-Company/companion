package web

import (
	"context"
	"encoding/json"
	"html/template"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/The-Vibe-Company/companion/internal/status"
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

func TestStatusAPIExposesDashboardContract(t *testing.T) {
	poller := status.NewPoller(staticSource{snapshot: status.Snapshot{
		Workspace:   "test-workspace",
		GeneratedAt: time.Unix(100, 0).UTC(),
		Services: []status.ServiceStatus{
			{ID: "research", Kind: "agent", URL: "https://research.tail.ts.net/", Health: status.HealthOK, Online: true},
			{ID: "open-webui", Kind: "openwebui", URL: "https://companion-webui.tail.ts.net/", Health: status.HealthOK, Online: true},
		},
		Summary: status.Summary{Total: 2, Healthy: 2},
	}}, time.Minute)
	poller.Refresh(context.Background())

	handler, err := newDashboardHandler(poller, time.Minute, nil, nil, nil)
	if err != nil {
		t.Fatalf("dashboard handler: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/status", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("GET /api/status status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("GET /api/status Cache-Control = %q, want no-store", got)
	}
	var got status.Snapshot
	if err := json.NewDecoder(recorder.Body).Decode(&got); err != nil {
		t.Fatalf("decode status JSON: %v", err)
	}
	if got.Workspace != "test-workspace" {
		t.Fatalf("workspace = %q", got.Workspace)
	}
	if len(got.Services) != 2 {
		t.Fatalf("expected two services, got %#v", got.Services)
	}
	if got.Services[0].Kind != "agent" || got.Services[0].URL != "https://research.tail.ts.net/" {
		t.Fatalf("agent contract lost: %#v", got.Services[0])
	}
	if got.Services[1].Kind != "openwebui" || got.Services[1].URL != "https://companion-webui.tail.ts.net/" {
		t.Fatalf("support service contract lost: %#v", got.Services[1])
	}
}

func TestDashboardAssetsKeepAgentAndSupportContracts(t *testing.T) {
	indexHTML := readAsset(t, "assets/index.html")
	dashboardJS := readAsset(t, "assets/dashboard.js")
	dashboardCSS := readAsset(t, "assets/dashboard.css")

	for _, want := range []string{
		`aria-label="Fleet agents"`,
		`id="services-body"`,
		`id="support-section"`,
		`id="support-body"`,
		`id="support-count"`,
	} {
		if !strings.Contains(indexHTML, want) {
			t.Fatalf("dashboard index missing contract %q", want)
		}
	}
	for _, want := range []string{
		`function agentServices()`,
		`function supportServices()`,
		`renderSupport();`,
		`svc.kind === "agent"`,
		`svc.kind !== "agent"`,
	} {
		if !strings.Contains(dashboardJS, want) {
			t.Fatalf("dashboard JS missing contract %q", want)
		}
	}
	if !strings.Contains(dashboardCSS, ".support-section[hidden]") {
		t.Fatalf("dashboard CSS must keep support section hide/show rule")
	}
}

type staticSource struct {
	snapshot status.Snapshot
}

func (s staticSource) Collect(context.Context) status.Snapshot {
	return s.snapshot
}

func readAsset(t *testing.T, name string) string {
	t.Helper()
	data, err := fs.ReadFile(assets, name)
	if err != nil {
		t.Fatalf("read embedded asset %s: %v", name, err)
	}
	return string(data)
}
