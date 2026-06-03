package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/providertest"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestCLIProviderMockE2E(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.SetTailscaleDevices([]tailscale.Device{{
		ID:       "dev-victor",
		HostName: "victor",
		DNSName:  "victor.tail.ts.net.",
		Online:   true,
	}, {
		ID:       "dev-webui",
		HostName: "companion-webui",
		DNSName:  "companion-webui.tail.ts.net.",
		Online:   true,
	}})
	root := writeCLIMockWorkspace(t, server)
	writeCLIProviderTestFile(t, root, ".env", `FLY_API_TOKEN=fly-secret
TAILSCALE_API_KEY=tailscale-secret
TS_AUTHKEY=tailscale-auth-secret
OPENROUTER_API_KEY=openrouter-secret
API_SERVER_KEY=api-secret
WEBUI_SECRET_KEY=webui-secret
`)
	for key, value := range map[string]string{
		"FLY_API_TOKEN":      "fly-secret",
		"TAILSCALE_API_KEY":  "tailscale-secret",
		"TS_AUTHKEY":         "tailscale-auth-secret",
		"OPENROUTER_API_KEY": "openrouter-secret",
		"API_SERVER_KEY":     "api-secret",
		"WEBUI_SECRET_KEY":   "webui-secret",
	} {
		t.Setenv(key, value)
	}
	runner := &execx.FakeRunner{}

	validateOutput, err := runCompanionForTest(runner, "--workspace", root, "validate", "--providers")
	if err != nil {
		t.Fatalf("validate --providers: %v\n%s", err, validateOutput)
	}
	if !strings.Contains(validateOutput, "providers: ok") {
		t.Fatalf("unexpected validate output: %s", validateOutput)
	}
	if !strings.Contains(validateOutput, "credentials: ok") {
		t.Fatalf("unexpected validate output: %s", validateOutput)
	}
	planOutput, err := runCompanionForTest(runner, "--workspace", root, "plan", "--json")
	if err != nil {
		t.Fatalf("plan: %v\n%s", err, planOutput)
	}
	if !strings.Contains(planOutput, `"address": "fly_app.agent.victor"`) {
		t.Fatalf("unexpected plan output: %s", planOutput)
	}
	if strings.Contains(planOutput, "api-secret") || strings.Contains(planOutput, "openrouter-secret") {
		t.Fatalf("plan leaked secret value: %s", planOutput)
	}
	applyOutput, err := runCompanionForTest(runner, "--workspace", root, "apply")
	if err != nil {
		t.Fatalf("apply: %v\n%s", err, applyOutput)
	}
	if len(runner.Calls) != 2 {
		t.Fatalf("expected two rollout calls, got %#v", runner.Calls)
	}
	outputURL, err := runCompanionForTest(runner, "--workspace", root, "output", "open_webui_url", "--raw")
	if err != nil {
		t.Fatalf("output: %v\n%s", err, outputURL)
	}
	if strings.TrimSpace(outputURL) != "https://companion-webui.tail.ts.net/" {
		t.Fatalf("unexpected webui url: %s", outputURL)
	}
	store, err := state.Open(filepath.Join(root, ".companion", "state.sqlite"))
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	resources, err := store.ListResources(context.Background())
	_ = store.Close()
	if err != nil {
		t.Fatalf("list state: %v", err)
	}
	if len(resources) == 0 {
		t.Fatalf("expected state resources")
	}
	for _, resource := range resources {
		if strings.Contains(resource.ObservedJSON, "api-secret") || strings.Contains(resource.ObservedJSON, "openrouter-secret") {
			t.Fatalf("state leaked secret value: %#v", resource)
		}
	}
	destroyOutput, err := runCompanionForTest(runner, "--workspace", root, "destroy", "fly_volume.agent_data.victor", "--confirm", "victor")
	if err == nil {
		t.Fatalf("expected protected data destroy error, got output %s", destroyOutput)
	}
	if !strings.Contains(err.Error(), "--destroy-data --backup-first") {
		t.Fatalf("unexpected destroy error: %v\n%s", err, destroyOutput)
	}
}

func runCompanionForTest(runner *execx.FakeRunner, args ...string) (string, error) {
	cmd := newRootCommand(runner)
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetErr(&output)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return output.String(), err
}

func writeCLIMockWorkspace(t *testing.T, server *providertest.Server) string {
	t.Helper()
	root := t.TempDir()
	writeCLIProviderTestFile(t, root, "companion.toml", `workspace = "test-companion"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
`)
	writeCLIProviderTestFile(t, root, "providers.toml", `[fly.default]
mode = "api"
api_base_url = "`+server.FlyBaseURL()+`"
token_env = "FLY_API_TOKEN"
region = "cdg"

[tailscale.tvc]
mode = "api"
api_base_url = "`+server.TailscaleBaseURL()+`"
tailnet = "tail.ts.net"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
api_base_url = "`+server.OpenRouterBaseURL()+`"
api_key_env = "OPENROUTER_API_KEY"
`)
	writeCLIProviderTestFile(t, root, "defaults.toml", `[defaults]
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
	writeCLIProviderTestFile(t, root, "webui.toml", `[open_webui]
enabled = true
id = "open-webui"
runtime = "fly.default"
network = "tailscale.tvc"
fly_app = "tvc-companion-webui"
tailscale_hostname = "companion-webui"
volume_name = "open_webui_data"
volume_size_gb = 5
webui_secret_key_secret_name = "WEBUI_SECRET_KEY"
openai_api_keys_secret_name = "OPENAI_API_KEYS"
tailscale_authkey_secret_name = "TS_AUTHKEY"
tailscale_serve = true
`)
	writeCLIProviderTestFile(t, root, "agents/victor.toml", `[agent]
id = "victor"
runtime = "fly.default"
network = "tailscale.tvc"
model_provider = "openrouter.default"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"
`)
	return root
}

func writeCLIProviderTestFile(t *testing.T, root, path, content string) {
	t.Helper()
	fullPath := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(fullPath, []byte(strings.TrimSpace(content)+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
