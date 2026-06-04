package status

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

type fakeFly struct {
	machines map[string][]fly.Machine
}

func (f fakeFly) AppExists(context.Context, string) (bool, error) { return true, nil }
func (f fakeFly) CreateApp(context.Context, string) error         { return nil }
func (f fakeFly) DeleteApp(context.Context, string) error         { return nil }
func (f fakeFly) ListVolumes(context.Context, string) ([]fly.Volume, error) {
	return nil, nil
}
func (f fakeFly) EnsureVolume(context.Context, string, string, string, int) (string, error) {
	return "", nil
}
func (f fakeFly) DeleteVolume(context.Context, string, string) error           { return nil }
func (f fakeFly) SecretNames(context.Context, string) (map[string]bool, error) { return nil, nil }
func (f fakeFly) SetSecrets(context.Context, string, map[string]string) error  { return nil }
func (f fakeFly) ListMachines(_ context.Context, app string) ([]fly.Machine, error) {
	return f.machines[app], nil
}

type fakeTS struct {
	devices []tailscale.Device
}

func (f fakeTS) Devices(context.Context) ([]tailscale.Device, error) { return f.devices, nil }

func TestBuildTopology(t *testing.T) {
	cfg := &config.Config{
		Agents: []config.Agent{
			{
				ID:                "research",
				Runtime:           "fly.default",
				FlyApp:            "co-research",
				TailscaleHostname: "research",
				DashboardMode:     "serve",
				DashboardPort:     9119,
				Model:             config.Model{Default: "gpt"},
				DefaultVault:      config.DefaultVault{Name: "Research"},
				APIServer:         config.APIServer{Enabled: true, Port: 8642},
			},
			{ID: "gone", Lifecycle: "absent", FlyApp: "co-gone", TailscaleHostname: "gone"},
		},
		OpenWebUI: config.OpenWebUI{Enabled: true, ID: "open-webui", Runtime: "fly.default", FlyApp: "co-webui", TailscaleHostname: "companion-webui", Port: 8080, TailscaleServe: true},
	}
	devices := []tailscale.Device{
		{HostName: "research", DNSName: "research.example.ts.net.", Online: true},
		{HostName: "companion-webui", DNSName: "companion-webui.example.ts.net.", Online: true},
	}
	topo := BuildTopology("ws", cfg, devices, ProviderSummary{Tailnet: "example.ts.net"}, time.Time{})

	if len(topo.Services) != 2 {
		t.Fatalf("expected 2 services (absent agent skipped), got %d", len(topo.Services))
	}
	if topo.Services[0].ID != "research" || topo.Services[0].Kind != "agent" {
		t.Fatalf("unexpected first service: %+v", topo.Services[0])
	}
	if topo.Services[0].HealthURL == "" {
		t.Fatalf("agent with api server should have a health URL")
	}
	if topo.Services[0].URL != "https://research.example.ts.net/" {
		t.Fatalf("agent URL should point at Hermes dashboard, got %q", topo.Services[0].URL)
	}
	if topo.Services[1].Kind != "openwebui" {
		t.Fatalf("expected open webui target, got %+v", topo.Services[1])
	}
	if topo.Services[1].URL != "https://companion-webui.example.ts.net/" {
		t.Fatalf("open webui URL should be exposed, got %q", topo.Services[1].URL)
	}
	if topo.Services[1].HealthURL != "https://companion-webui.example.ts.net/health" {
		t.Fatalf("open webui health URL should be exposed, got %q", topo.Services[1].HealthURL)
	}

	// JSON round-trip is stable and carries the provider summary.
	data, err := topo.JSON()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseTopology(data)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Providers.Tailnet != "example.ts.net" {
		t.Fatalf("provider summary lost in round-trip: %+v", parsed.Providers)
	}
}

func TestBuildTopologyDoesNotInventDisplayURLsWithoutTailscaleDevices(t *testing.T) {
	cfg := &config.Config{
		Agents: []config.Agent{{
			ID:                "research",
			Runtime:           "fly.default",
			FlyApp:            "co-research",
			TailscaleHostname: "research",
			DashboardMode:     "serve",
			DashboardPort:     9119,
			APIServer:         config.APIServer{Enabled: true, Port: 8642},
		}},
		OpenWebUI: config.OpenWebUI{
			Enabled:           true,
			ID:                "open-webui",
			Runtime:           "fly.default",
			FlyApp:            "co-webui",
			TailscaleHostname: "companion-webui",
			Port:              8080,
			TailscaleServe:    true,
		},
	}

	topo := BuildTopology("ws", cfg, nil, ProviderSummary{}, time.Time{})
	if got := topo.Services[0].URL; got != "" {
		t.Fatalf("agent display URL should stay empty without a resolved device, got %q", got)
	}
	if got := topo.Services[0].HealthURL; got != "http://research:8642/health" {
		t.Fatalf("agent health probe should still use configured hostname fallback, got %q", got)
	}
	if got := topo.Services[1].URL; got != "" {
		t.Fatalf("Open WebUI display URL should stay empty without a resolved device, got %q", got)
	}
	if got := topo.Services[1].HealthURL; got != "" {
		t.Fatalf("Open WebUI health URL should stay empty without a resolved device, got %q", got)
	}
}

func TestCollectHealthAndSummary(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ok.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()

	topo := FleetTopology{
		Workspace: "ws",
		Services: []Target{
			{ID: "up", Kind: "agent", FlyApp: "co-up", TailscaleHostname: "up", URL: "https://up.example.ts.net/", HealthURL: ok.URL + "/health"},
			{ID: "degraded", Kind: "agent", FlyApp: "co-deg", HealthURL: bad.URL + "/health"},
			{ID: "down", Kind: "agent", FlyApp: "co-down", HealthURL: "http://127.0.0.1:0/health"},
			{ID: "webui", Kind: "openwebui", FlyApp: "co-webui", TailscaleHostname: "companion-webui"},
		},
	}
	flyProvider := fakeFly{machines: map[string][]fly.Machine{
		"co-up":    {{State: "started"}},
		"co-webui": {{State: "stopped"}},
	}}
	tsProvider := fakeTS{devices: []tailscale.Device{{HostName: "up", Online: true}}}

	snap := Collect(context.Background(), topo, flyProvider, tsProvider, nil)

	byID := map[string]ServiceStatus{}
	for _, svc := range snap.Services {
		byID[svc.ID] = svc
	}
	if byID["up"].Health != HealthOK {
		t.Fatalf("up should be ok, got %q", byID["up"].Health)
	}
	if !byID["up"].Online {
		t.Fatalf("up should be online via tailscale")
	}
	if byID["up"].MachineState != "started" {
		t.Fatalf("up machine state should be started, got %q", byID["up"].MachineState)
	}
	if byID["up"].URL != "https://up.example.ts.net/" {
		t.Fatalf("up URL should expose dashboard URL, got %q", byID["up"].URL)
	}
	if byID["degraded"].URL != "" {
		t.Fatalf("health URL should not leak into display URL, got %q", byID["degraded"].URL)
	}
	if byID["degraded"].Health != HealthDegrade {
		t.Fatalf("degraded should be degraded, got %q", byID["degraded"].Health)
	}
	if byID["down"].Health != HealthDown {
		t.Fatalf("down should be down, got %q", byID["down"].Health)
	}
	// No health URL: falls back to machine state (stopped -> down).
	if byID["webui"].Health != HealthDown {
		t.Fatalf("stopped webui should be down, got %q", byID["webui"].Health)
	}

	if snap.Summary.Total != 4 || snap.Summary.Healthy != 1 || snap.Summary.Down != 2 || snap.Summary.Degraded != 1 {
		t.Fatalf("unexpected summary: %+v", snap.Summary)
	}
}

func TestCollectUsesOpenWebUIHealthProbe(t *testing.T) {
	webui := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("unexpected health probe path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":true}`))
	}))
	defer webui.Close()

	topo := FleetTopology{
		Workspace: "ws",
		Services: []Target{{
			ID:                "open-webui",
			Kind:              "openwebui",
			FlyApp:            "co-webui",
			TailscaleHostname: "companion-webui",
			URL:               "https://companion-webui.example.ts.net/",
			HealthURL:         webui.URL + "/health",
		}},
	}
	snap := Collect(context.Background(), topo, nil, nil, nil)

	if len(snap.Services) != 1 {
		t.Fatalf("expected one service, got %#v", snap.Services)
	}
	if snap.Services[0].Health != HealthOK || snap.Services[0].HTTPStatus != http.StatusOK {
		t.Fatalf("Open WebUI health probe should mark service ok, got %#v", snap.Services[0])
	}
	if snap.Services[0].URL != "https://companion-webui.example.ts.net/" {
		t.Fatalf("Open WebUI display URL should remain separate from health URL, got %q", snap.Services[0].URL)
	}
}

func TestPollerRefresh(t *testing.T) {
	topo := FleetTopology{Workspace: "ws", Services: []Target{{ID: "webui", Kind: "openwebui", FlyApp: "co"}}}
	src := ManifestSource{Topology: topo, Fly: fakeFly{}, Tailscale: fakeTS{}}
	poller := NewPoller(src, time.Minute)

	if got := poller.Snapshot(); got.Summary.Total != 0 {
		t.Fatalf("expected empty cache before refresh, got %+v", got.Summary)
	}
	snap := poller.Refresh(context.Background())
	if snap.Summary.Total != 1 {
		t.Fatalf("expected 1 service after refresh, got %d", snap.Summary.Total)
	}
	if poller.Snapshot().Summary.Total != 1 {
		t.Fatalf("cache not updated after refresh")
	}
}
