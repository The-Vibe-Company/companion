package plan

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestGraphJSON(t *testing.T) {
	cfg := &config.Config{Agents: []config.Agent{{
		ID: "writer",
		DefaultVault: config.DefaultVault{
			Enabled: true,
			MCPRole: "write",
		},
		VaultConnections: []config.VaultConnection{{
			Name: "companion-test",
			Mode: "sync",
			Role: "write",
		}},
	}}}
	graph := BuildGraph(cfg)
	data, err := graph.JSON()
	if err != nil {
		t.Fatalf("json: %v", err)
	}
	var decoded Graph
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded.Edges) != 2 {
		t.Fatalf("expected owns + sync edges, got %#v", decoded.Edges)
	}
}

func TestBuildNoOpsOpenWebUIWhenBackendsMatch(t *testing.T) {
	cfg := &config.Config{
		OpenWebUI: config.OpenWebUI{
			Enabled: true,
			FlyApp:  "webui",
		},
		Agents: []config.Agent{{
			ID:         "agent",
			FlyApp:     "agent",
			VolumeName: "data",
			APIServer: config.APIServer{
				Enabled:          true,
				Port:             8642,
				OpenWebUIEnabled: true,
				OpenWebUIURL:     "http://agent:8642/v1",
			},
		}},
	}
	flyRunner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly status -a agent":              {ExitCode: 0},
		"fly volumes list -a agent --json": {Stdout: `[{"id":"vol","name":"data","size_gb":1}]`},
		"fly machines list -a webui --json": {Stdout: `[
			{"id":"machine","state":"started","config":{"env":{"OPENAI_API_BASE_URLS":"http://agent:8642/v1"}}}
		]`},
	}}
	tsRunner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{}`},
	}}
	report := Build(context.Background(), cfg, cfg.Agents, fly.New(flyRunner), tailscale.New(tsRunner))
	if !strings.Contains(report.String(), "= no-op open-webui backends agent") {
		t.Fatalf("expected open-webui no-op, got:\n%s", report.String())
	}
}
