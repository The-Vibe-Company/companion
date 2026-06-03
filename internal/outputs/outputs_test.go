package outputs

import (
	"context"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestBuildFleetOutputs(t *testing.T) {
	cfg := &config.Config{
		Agents: []config.Agent{{
			ID:                "sample",
			FlyApp:            "example-companion-sample",
			Region:            "cdg",
			TailscaleHostname: "sample",
			DashboardMode:     "serve",
			DashboardPort:     9119,
			GraniteEnabled:    true,
			Model: config.Model{
				Default: "google/gemini-3.5-flash",
			},
			APIServer: config.APIServer{
				Enabled:          true,
				OpenWebUIEnabled: true,
				Port:             8642,
				ModelName:        "sample",
				KeySecretName:    "API_SERVER_KEY",
			},
			DefaultVault: config.DefaultVault{
				Enabled:      true,
				Name:         "Sample Agent",
				Path:         "/opt/data/.granite",
				MCPName:      "granite",
				MCPRole:      "write",
				SyncServe:    true,
				SyncPort:     8765,
				WriteServe:   true,
				WritePort:    3321,
				SyncInterval: 30,
			},
		}},
		OpenWebUI: config.OpenWebUI{
			Enabled:           true,
			FlyApp:            "example-companion-webui",
			TailscaleHostname: "companion-webui",
			Port:              8080,
			TailscaleServe:    true,
		},
	}
	flyProvider := fly.New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"fly machines list -a example-companion-sample --json": {Stdout: `[{"id":"machine-sample","state":"started","config":{"env":{}}}]`},
		"fly machines list -a example-companion-webui --json":  {Stdout: `[{"id":"machine-webui","state":"started","config":{"env":{}}}]`},
	}})
	tsProvider := tailscale.New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{
			"sample":{"ID":"device-sample","HostName":"sample","DNSName":"sample.tail.ts.net.","Online":true,"TailscaleIPs":["100.64.0.2"]},
			"webui":{"ID":"device-webui","HostName":"companion-webui","DNSName":"companion-webui.tail.ts.net.","Online":true,"TailscaleIPs":["100.64.0.3"]}
		}}`},
	}})

	fleet := Build(context.Background(), cfg, flyProvider, tsProvider)
	sample := fleet.Agents["sample"]
	if sample.DashboardURL != "https://sample.tail.ts.net/" {
		t.Fatalf("unexpected dashboard URL: %s", sample.DashboardURL)
	}
	if sample.OpenAIBaseURL != "http://sample.tail.ts.net:8642/v1" {
		t.Fatalf("unexpected OpenAI base URL: %s", sample.OpenAIBaseURL)
	}
	if sample.DefaultVault.SyncURL != "http://sample.tail.ts.net:8765/sync" {
		t.Fatalf("unexpected Granite sync URL: %s", sample.DefaultVault.SyncURL)
	}
	if sample.DefaultVault.WriteMCPURL != "http://sample.tail.ts.net:3321/mcp" {
		t.Fatalf("unexpected Granite MCP URL: %s", sample.DefaultVault.WriteMCPURL)
	}
	if fleet.OpenWebUIURL != "https://companion-webui.tail.ts.net/" {
		t.Fatalf("unexpected Open WebUI URL: %s", fleet.OpenWebUIURL)
	}
	if len(fleet.OpenWebUIBackends) != 1 || fleet.OpenWebUIBackends[0].URL != "http://sample.tail.ts.net:8642/v1" {
		t.Fatalf("unexpected WebUI backends: %#v", fleet.OpenWebUIBackends)
	}
}

func TestLookupAndRawString(t *testing.T) {
	fleet := Fleet{Agents: map[string]Agent{
		"sample": {DashboardURL: "https://sample.tail.ts.net/"},
	}}
	value, err := Lookup(fleet, "agents.sample.dashboard_url")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	raw, err := RawString(value)
	if err != nil {
		t.Fatalf("raw string: %v", err)
	}
	if raw != "https://sample.tail.ts.net/" {
		t.Fatalf("unexpected raw value: %s", raw)
	}
}

func TestBuildFleetOutputsDoesNotInventRuntimeURLsForMissingTailscaleDevice(t *testing.T) {
	cfg := &config.Config{Agents: []config.Agent{{
		ID:                "secondary",
		FlyApp:            "example-secondary-app",
		TailscaleHostname: "example-secondary",
		DashboardMode:     "serve",
		DashboardPort:     9119,
		APIServer: config.APIServer{
			Enabled:   true,
			Port:      8642,
			ModelName: "secondary",
		},
	}}}
	flyProvider := fly.New(&execx.FakeRunner{})
	tsProvider := tailscale.New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{}}`},
	}})

	fleet := Build(context.Background(), cfg, flyProvider, tsProvider)
	secondary := fleet.Agents["secondary"]
	if secondary.TailscaleDNS != "" || secondary.DashboardURL != "" || secondary.APIBaseURL != "" {
		t.Fatalf("expected no runtime URLs for missing device, got %#v", secondary)
	}
}

func TestTextDoesNotPrintSecretValues(t *testing.T) {
	text := Text(Fleet{
		AgentIDValues: []string{"sample"},
		Agents: map[string]Agent{
			"sample": {
				FlyApp:       "example-companion-sample",
				DashboardURL: "https://sample.tail.ts.net/",
			},
		},
	})
	if strings.Contains(text, "API_SERVER_KEY=") || strings.Contains(text, "TS_AUTHKEY=") {
		t.Fatalf("text output should not contain secret assignments: %s", text)
	}
}
