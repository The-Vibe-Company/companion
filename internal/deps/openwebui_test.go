package deps

import (
	"context"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestOpenWebUIConnectionsResolveActiveTailscaleDNS(t *testing.T) {
	cfg := &config.Config{Agents: []config.Agent{{
		ID:                "example-peer",
		TailscaleHostname: "example-peer",
		APIServer: config.APIServer{
			Enabled:          true,
			OpenWebUIEnabled: true,
			Port:             8642,
			ModelName:        "example-peer",
			KeySecretName:    "API_SERVER_KEY",
		},
	}}}
	provider := tailscale.New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{
			"old":{"HostName":"example-peer","DNSName":"example-peer.tail.ts.net.","Online":false},
			"active":{"HostName":"example-peer","DNSName":"example-peer-2.tail.ts.net.","Online":true}
		}}`},
	}})
	connections := OpenWebUIConnections(context.Background(), cfg, provider)
	if len(connections) != 1 {
		t.Fatalf("expected one connection, got %#v", connections)
	}
	if connections[0].URL != "http://example-peer-2.tail.ts.net:8642/v1" {
		t.Fatalf("unexpected URL: %s", connections[0].URL)
	}
}

func TestAgentAPIBaseURLKeepsExplicitHost(t *testing.T) {
	agent := config.Agent{
		TailscaleHostname: "example-peer",
		APIServer: config.APIServer{
			Port:          8642,
			OpenWebUIHost: "manual.tail.ts.net",
		},
	}
	devices := []tailscale.Device{{
		HostName: "example-peer",
		DNSName:  "example-peer-2.tail.ts.net.",
		Online:   true,
	}}
	if got := AgentAPIBaseURL(agent, devices); got != "http://manual.tail.ts.net:8642" {
		t.Fatalf("unexpected base URL: %s", got)
	}
}

func TestAgentDashboardURLUsesConfiguredHermesDashboardMode(t *testing.T) {
	devices := []tailscale.Device{
		{HostName: "agent", DNSName: "agent.tail.ts.net.", Online: false},
		{HostName: "agent", DNSName: "agent-2.tail.ts.net.", Online: true},
	}
	tests := []struct {
		name  string
		agent config.Agent
		want  string
	}{
		{
			name: "tailscale serve uses https dashboard",
			agent: config.Agent{
				TailscaleHostname: "agent",
				DashboardMode:     "serve",
				DashboardPort:     9119,
			},
			want: "https://agent-2.tail.ts.net/",
		},
		{
			name: "tailnet port keeps explicit dashboard port",
			agent: config.Agent{
				TailscaleHostname: "agent",
				DashboardMode:     "tailnet-port",
				DashboardPort:     9119,
			},
			want: "http://agent-2.tail.ts.net:9119",
		},
		{
			name: "off mode exposes no user dashboard URL",
			agent: config.Agent{
				TailscaleHostname: "agent",
				DashboardMode:     "off",
				DashboardPort:     9119,
			},
			want: "",
		},
		{
			name: "missing tailscale device exposes no invented URL",
			agent: config.Agent{
				TailscaleHostname: "missing",
				DashboardMode:     "serve",
				DashboardPort:     9119,
			},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := AgentDashboardURL(tt.agent, devices); got != tt.want {
				t.Fatalf("AgentDashboardURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestOpenWebUIURLUsesTailnetAccessMode(t *testing.T) {
	devices := []tailscale.Device{{
		HostName: "companion-webui",
		DNSName:  "companion-webui.tail.ts.net.",
		Online:   true,
	}}
	tests := []struct {
		name string
		cfg  config.OpenWebUI
		want string
	}{
		{
			name: "tailscale serve uses https support URL",
			cfg: config.OpenWebUI{
				TailscaleHostname: "companion-webui",
				TailscaleServe:    true,
				Port:              8080,
			},
			want: "https://companion-webui.tail.ts.net/",
		},
		{
			name: "tailnet port uses configured webui port",
			cfg: config.OpenWebUI{
				TailscaleHostname: "companion-webui",
				TailscaleServe:    false,
				Port:              8080,
			},
			want: "http://companion-webui.tail.ts.net:8080",
		},
		{
			name: "missing tailscale device exposes no invented URL",
			cfg: config.OpenWebUI{
				TailscaleHostname: "missing-webui",
				TailscaleServe:    true,
				Port:              8080,
			},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := OpenWebUIURL(tt.cfg, devices); got != tt.want {
				t.Fatalf("OpenWebUIURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestOpenWebUIHealthURLUsesSameTailnetAccessMode(t *testing.T) {
	devices := []tailscale.Device{{
		HostName: "companion-webui",
		DNSName:  "companion-webui.tail.ts.net.",
		Online:   true,
	}}
	tests := []struct {
		name string
		cfg  config.OpenWebUI
		want string
	}{
		{
			name: "tailscale serve probes webui health over https",
			cfg: config.OpenWebUI{
				TailscaleHostname: "companion-webui",
				TailscaleServe:    true,
				Port:              8080,
			},
			want: "https://companion-webui.tail.ts.net/health",
		},
		{
			name: "tailnet port probes configured webui port",
			cfg: config.OpenWebUI{
				TailscaleHostname: "companion-webui",
				TailscaleServe:    false,
				Port:              8080,
			},
			want: "http://companion-webui.tail.ts.net:8080/health",
		},
		{
			name: "missing tailscale device has no health probe",
			cfg: config.OpenWebUI{
				TailscaleHostname: "missing-webui",
				TailscaleServe:    true,
				Port:              8080,
			},
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := OpenWebUIHealthURL(tt.cfg, devices); got != tt.want {
				t.Fatalf("OpenWebUIHealthURL() = %q, want %q", got, tt.want)
			}
		})
	}
}
