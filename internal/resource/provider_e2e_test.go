package resource

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/provider"
	"github.com/The-Vibe-Company/companion/internal/providertest"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

func TestMockProviderE2EApplyIsIdempotentAndRedactsState(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.SetTailscaleDevices([]tailscale.Device{{
		ID:       "dev-sample",
		HostName: "sample",
		DNSName:  "sample.tail.ts.net.",
		Online:   true,
		IP:       "100.64.0.10",
	}, {
		ID:       "dev-webui",
		HostName: "companion-webui",
		DNSName:  "companion-webui.tail.ts.net.",
		Online:   true,
		IP:       "100.64.0.20",
	}})
	root := writeMockWorkspace(t, server)
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	store, err := state.Open(ws.StatePath)
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	defer store.Close()
	runner := &execx.FakeRunner{}
	env := mockEnv()
	providers, err := provider.NewSet(ws, env, runner)
	if err != nil {
		t.Fatalf("provider set: %v", err)
	}
	plan, err := BuildPlan(context.Background(), ws, store, providers, Options{Root: ws.Root, GeneratedDir: filepath.Join(ws.Root, ".companion", "generated")})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if !strings.Contains(plan.String(), "+ create fly_app.agent.sample example-companion-sample") {
		t.Fatalf("expected create app plan, got:\n%s", plan.String())
	}
	_, err = Apply(context.Background(), ws, store, providers, Options{Root: ws.Root, GeneratedDir: filepath.Join(ws.Root, ".companion", "generated"), Env: env})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(server.Apps) != 2 {
		t.Fatalf("expected agent and webui apps, got %#v", server.Apps)
	}
	if got := len(server.Apps["example-companion-sample"].Volumes); got != 1 {
		t.Fatalf("expected one agent volume, got %d", got)
	}
	if got := len(server.Apps["example-companion-webui"].Volumes); got != 1 {
		t.Fatalf("expected one webui volume, got %d", got)
	}
	if !server.Apps["example-companion-sample"].Secrets["API_SERVER_KEY"] || !server.Apps["example-companion-webui"].Secrets["OPENAI_API_KEYS"] {
		t.Fatalf("expected secret names to be stored, got agent=%#v webui=%#v", server.Apps["example-companion-sample"].Secrets, server.Apps["example-companion-webui"].Secrets)
	}
	if len(runner.Calls) != 2 {
		t.Fatalf("expected two rollout calls, got %#v", runner.Calls)
	}
	webuiConfig, err := os.ReadFile(filepath.Join(ws.Root, ".companion", "generated", "fly.open-webui.toml"))
	if err != nil {
		t.Fatalf("read webui config: %v", err)
	}
	if !strings.Contains(string(webuiConfig), "http://sample.tail.ts.net:8642/v1") {
		t.Fatalf("webui config did not use tailscale DNS:\n%s", string(webuiConfig))
	}
	resources, err := store.ListResources(context.Background())
	if err != nil {
		t.Fatalf("list state: %v", err)
	}
	for _, resource := range resources {
		if strings.Contains(resource.ObservedJSON, "api-secret") || strings.Contains(resource.ObservedJSON, "openrouter-secret") {
			t.Fatalf("state leaked secret value in %#v", resource)
		}
	}
	_, err = Apply(context.Background(), ws, store, providers, Options{Root: ws.Root, GeneratedDir: filepath.Join(ws.Root, ".companion", "generated"), Env: env})
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if got := len(server.Apps["example-companion-sample"].Volumes); got != 1 {
		t.Fatalf("second apply duplicated volume, got %d", got)
	}
	if len(runner.Calls) != 2 {
		t.Fatalf("second apply reran rollout, got %#v", runner.Calls)
	}
}

func TestMockProviderE2EReportsDuplicateVolumeDrift(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.AddVolume("example-companion-sample", flyVolume("vol_old", "data", 3, ""))
	server.AddVolume("example-companion-sample", flyVolume("vol_attached", "data", 3, "machine"))
	root := writeMockWorkspace(t, server)
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	store, err := state.Open(ws.StatePath)
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	defer store.Close()
	providers, err := provider.NewSet(ws, mockEnv(), &execx.FakeRunner{})
	if err != nil {
		t.Fatalf("provider set: %v", err)
	}
	plan, err := BuildPlan(context.Background(), ws, store, providers, Options{Root: ws.Root, Targets: []string{"fly_volume.agent_data.sample"}})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	if !strings.Contains(plan.String(), "! drift fly_volume.agent_data.sample duplicate volume reused vol_attached") {
		t.Fatalf("expected duplicate drift, got:\n%s", plan.String())
	}
}

func writeMockWorkspace(t *testing.T, server *providertest.Server) string {
	t.Helper()
	root := t.TempDir()
	writeResourceTestFile(t, root, "companion.toml", `workspace = "test-companion"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
`)
	writeResourceTestFile(t, root, "providers.toml", `[fly.default]
mode = "api"
api_base_url = "`+server.FlyBaseURL()+`"
token_env = "FLY_API_TOKEN"
region = "cdg"

[tailscale.default]
mode = "api"
api_base_url = "`+server.TailscaleBaseURL()+`"
tailnet = "tail.ts.net"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
api_base_url = "`+server.OpenRouterBaseURL()+`"
api_key_env = "OPENROUTER_API_KEY"
`)
	writeResourceTestFile(t, root, "defaults.toml", `[defaults]
region = "cdg"
volume_name = "data"
volume_size_gb = 3

[defaults.model]
enabled = true
default = "google/gemini-3.5-flash"
api_key_secret_name = "OPENROUTER_API_KEY"
api_key_env = "OPENROUTER_API_KEY"

[defaults.api_server]
enabled = true
open_webui_enabled = true
host = "0.0.0.0"
port = 8642
key_secret_name = "API_SERVER_KEY"

[defaults.default_vault]
enabled = true
name = "Default"
mcp_role = "write"
`)
	writeResourceTestFile(t, root, "webui.toml", `[open_webui]
enabled = true
id = "open-webui"
runtime = "fly.default"
network = "tailscale.default"
fly_app = "example-companion-webui"
tailscale_hostname = "companion-webui"
volume_name = "open_webui_data"
volume_size_gb = 5
webui_secret_key_secret_name = "WEBUI_SECRET_KEY"
openai_api_keys_secret_name = "OPENAI_API_KEYS"
tailscale_authkey_secret_name = "TS_AUTHKEY"
`)
	writeResourceTestFile(t, root, "agents/sample.toml", `[agent]
id = "sample"
runtime = "fly.default"
network = "tailscale.default"
model_provider = "openrouter.default"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`)
	return root
}

func writeResourceTestFile(t *testing.T, root, path, content string) {
	t.Helper()
	fullPath := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(fullPath, []byte(strings.TrimSpace(content)+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mockEnv() map[string]string {
	return map[string]string{
		"FLY_API_TOKEN":      "fly-secret",
		"TAILSCALE_API_KEY":  "tailscale-secret",
		"TS_AUTHKEY":         "tailscale-auth-secret",
		"OPENROUTER_API_KEY": "openrouter-secret",
		"API_SERVER_KEY":     "api-secret",
		"WEBUI_SECRET_KEY":   "webui-secret",
	}
}

func flyVolume(id, name string, sizeGB int, attached string) fly.Volume {
	return fly.Volume{ID: id, Name: name, SizeGB: sizeGB, Region: "cdg", AttachedMachineID: attached}
}
