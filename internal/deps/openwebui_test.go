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
		ID:                "companion-test",
		TailscaleHostname: "companion-test",
		APIServer: config.APIServer{
			Enabled:          true,
			OpenWebUIEnabled: true,
			Port:             8642,
			ModelName:        "companion-test",
			KeySecretName:    "API_SERVER_KEY",
		},
	}}}
	provider := tailscale.New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{
			"old":{"HostName":"companion-test","DNSName":"companion-test.tail.ts.net.","Online":false},
			"active":{"HostName":"companion-test","DNSName":"companion-test-2.tail.ts.net.","Online":true}
		}}`},
	}})
	connections := OpenWebUIConnections(context.Background(), cfg, provider)
	if len(connections) != 1 {
		t.Fatalf("expected one connection, got %#v", connections)
	}
	if connections[0].URL != "http://companion-test-2.tail.ts.net:8642/v1" {
		t.Fatalf("unexpected URL: %s", connections[0].URL)
	}
}

func TestAgentAPIBaseURLKeepsExplicitHost(t *testing.T) {
	agent := config.Agent{
		TailscaleHostname: "companion-test",
		APIServer: config.APIServer{
			Port:          8642,
			OpenWebUIHost: "manual.tail.ts.net",
		},
	}
	devices := []tailscale.Device{{
		HostName: "companion-test",
		DNSName:  "companion-test-2.tail.ts.net.",
		Online:   true,
	}}
	if got := AgentAPIBaseURL(agent, devices); got != "http://manual.tail.ts.net:8642" {
		t.Fatalf("unexpected base URL: %s", got)
	}
}
