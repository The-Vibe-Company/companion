package plan

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestGraphJSON(t *testing.T) {
	cfg := &config.Config{Agents: []config.Agent{{
		ID: "secondary",
		DefaultVault: config.DefaultVault{
			Enabled: true,
			MCPRole: "write",
		},
		VaultConnections: []config.VaultConnection{{
			Name: "example-peer",
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
	report, err := Build(context.Background(), cfg, cfg.Agents, fly.New(flyRunner), tailscale.New(tsRunner))
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if !strings.Contains(report.String(), "= no-op open-webui backends agent") {
		t.Fatalf("expected open-webui no-op, got:\n%s", report.String())
	}
}

func TestBuildReturnsProviderErrors(t *testing.T) {
	cfg := &config.Config{Agents: []config.Agent{{
		ID:         "agent",
		FlyApp:     "agent",
		VolumeName: "data",
	}}}
	flyRunner := &execx.FakeRunner{Errors: map[string]error{
		"fly status -a agent": errors.New("fly unavailable"),
	}}
	tsRunner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{}`},
	}}
	_, err := Build(context.Background(), cfg, cfg.Agents, fly.New(flyRunner), tailscale.New(tsRunner))
	if err == nil {
		t.Fatalf("expected provider error")
	}
	if !strings.Contains(err.Error(), "inspect fly app agent") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDriftReturnsTailscaleErrors(t *testing.T) {
	cfg := &config.Config{Agents: []config.Agent{{
		ID:         "agent",
		FlyApp:     "agent",
		VolumeName: "data",
	}}}
	flyRunner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly volumes list -a agent --json": {Stdout: `[]`},
	}}
	tsRunner := &execx.FakeRunner{Errors: map[string]error{
		"tailscale status --json": errors.New("tailscale unavailable"),
	}}
	_, err := Drift(context.Background(), cfg, fly.New(flyRunner), tailscale.New(tsRunner))
	if err == nil {
		t.Fatalf("expected tailscale error")
	}
	if !strings.Contains(err.Error(), "inspect tailscale devices") {
		t.Fatalf("unexpected error: %v", err)
	}
}
