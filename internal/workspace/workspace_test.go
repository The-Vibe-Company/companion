package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadRepositoryWorkspaceShape(t *testing.T) {
	ws, err := Load(filepath.Join("..", "..", "examples", "minimal"))
	if err != nil {
		t.Fatalf("load example workspace: %v", err)
	}
	if ws.Name != "companion-minimal" {
		t.Fatalf("unexpected workspace name: %s", ws.Name)
	}
	if len(ws.Config.Agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(ws.Config.Agents))
	}
	if ws.Config.OpenWebUI.Enabled {
		t.Fatalf("unexpected open webui config: %#v", ws.Config.OpenWebUI)
	}
	agent := ws.Config.Agents[0]
	if agent.ID != "example-agent" || agent.FlyApp != "example-companion-agent" {
		t.Fatalf("unexpected example agent: %#v", agent)
	}
	if ws.AgentFiles["example-agent"] == "" {
		t.Fatalf("expected example agent file mapping")
	}
}

func TestLoadFailsOnMissingCompanionTOML(t *testing.T) {
	_, err := Load(t.TempDir())
	if err == nil {
		t.Fatalf("expected missing companion.toml error")
	}
}

func TestLoadFailsOnDuplicateAgentIDs(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceFile(t, root, "agents/a.toml", `[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`)
	writeWorkspaceFile(t, root, "agents/b.toml", `[agent]
id = "sample"
fly_app = "example-companion-sample-2"
tailscale_hostname = "example-agent-2"
`)
	writeMinimalWorkspace(t, root)
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "duplicate agent id") {
		t.Fatalf("expected duplicate agent error, got %v", err)
	}
}

func TestLoadFailsOnUnknownProviderRef(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "agents/sample.toml", `[agent]
id = "sample"
runtime = "fly.missing"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`)
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "unknown runtime provider fly.missing") {
		t.Fatalf("expected unknown provider error, got %v", err)
	}
}

func TestLoadProviderAPIBaseURLsAndModes(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "providers.toml", `[fly.default]
mode = "api"
api_base_url = "http://127.0.0.1:3001/fly/v1"
token_env = "FLY_API_TOKEN"

[tailscale.default]
mode = "api"
tailnet = "tail.ts.net"
api_base_url = "http://127.0.0.1:3001/tailscale"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
api_base_url = "http://127.0.0.1:3001/openrouter/api/v1"
api_key_env = "OPENROUTER_API_KEY"
`)
	writeWorkspaceFile(t, root, "agents/sample.toml", `[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`)
	ws, err := Load(root)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if ws.Providers.Fly["default"].Mode != "api" || ws.Providers.Fly["default"].APIBaseURL == "" {
		t.Fatalf("unexpected fly provider: %#v", ws.Providers.Fly["default"])
	}
	if ws.Providers.Tailscale["default"].Mode != "api" || ws.Providers.Tailscale["default"].APIBaseURL == "" {
		t.Fatalf("unexpected tailscale provider: %#v", ws.Providers.Tailscale["default"])
	}
	if ws.Providers.OpenRouter["default"].APIBaseURL == "" {
		t.Fatalf("unexpected openrouter provider: %#v", ws.Providers.OpenRouter["default"])
	}
}

func TestLoadPreservesLegacyTailscaleDefaultWhenNetworkOmitted(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "providers.toml", `[fly.default]
region = "cdg"
token_env = "FLY_API_TOKEN"

[tailscale.tvc]
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
`)
	writeWorkspaceFile(t, root, "webui.toml", `[open_webui]
enabled = true
runtime = "fly.default"
fly_app = "example-companion-webui"
tailscale_hostname = "example-webui"
`)
	writeWorkspaceFile(t, root, "agents/sample.toml", `[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`)
	ws, err := Load(root)
	if err != nil {
		t.Fatalf("load legacy workspace: %v", err)
	}
	if ws.Config.Agents[0].Network != "tailscale.tvc" {
		t.Fatalf("expected legacy agent network, got %s", ws.Config.Agents[0].Network)
	}
	if ws.Config.OpenWebUI.Network != "tailscale.tvc" {
		t.Fatalf("expected legacy open webui network, got %s", ws.Config.OpenWebUI.Network)
	}
}

func TestLoadFailsOnWrongProviderKind(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "agents/sample.toml", `[agent]
id = "sample"
runtime = "openrouter.default"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`)
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "runtime must reference a fly provider") {
		t.Fatalf("expected provider kind error, got %v", err)
	}
}

func TestLoadFailsOnAbsoluteIdentityPath(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "agents/sample.toml", `[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
identity = "/tmp/SOUL.md"
`)
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "identity.path must be relative") {
		t.Fatalf("expected absolute identity path error, got %v", err)
	}
}

func TestLoadFailsOnDuplicateVaultIDs(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "agents/sample.toml", `[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`)
	writeWorkspaceFile(t, root, "vaults/a.toml", `[vault]
id = "shared"
`)
	writeWorkspaceFile(t, root, "vaults/b.toml", `[vault]
id = "shared"
`)
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "duplicate vault id") {
		t.Fatalf("expected duplicate vault error, got %v", err)
	}
}

func writeMinimalWorkspace(t *testing.T, root string) {
	t.Helper()
	writeWorkspaceFile(t, root, "companion.toml", `workspace = "test"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
`)
	writeWorkspaceFile(t, root, "providers.toml", `[fly.default]
region = "cdg"
token_env = "FLY_API_TOKEN"

[tailscale.default]
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
`)
	writeWorkspaceFile(t, root, "defaults.toml", `[defaults]
region = "cdg"

[defaults.model]
enabled = false
`)
	writeWorkspaceFile(t, root, "webui.toml", `[open_webui]
enabled = false
`)
}

func writeWorkspaceFile(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", name, err)
	}
	if err := os.WriteFile(path, []byte(strings.TrimSpace(content)+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}
