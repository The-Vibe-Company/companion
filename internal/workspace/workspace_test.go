package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadRepositoryWorkspaceShape(t *testing.T) {
	ws, err := Load(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("load repository workspace: %v", err)
	}
	if ws.Name != "tvc-companion" {
		t.Fatalf("unexpected workspace name: %s", ws.Name)
	}
	if len(ws.Config.Agents) != 4 {
		t.Fatalf("expected 4 agents, got %d", len(ws.Config.Agents))
	}
	if !ws.Config.OpenWebUI.Enabled || ws.Config.OpenWebUI.Runtime != "fly.default" {
		t.Fatalf("unexpected open webui config: %#v", ws.Config.OpenWebUI)
	}
	victor := ws.Config.Agents[2]
	if victor.ID != "victor" || !victor.Identity.Enabled || victor.Identity.Path != "identities/victor/SOUL.md" {
		t.Fatalf("unexpected victor identity: %#v", victor)
	}
	if ws.AgentFiles["victor"] == "" {
		t.Fatalf("expected victor agent file mapping")
	}
	if len(ws.Vaults) != 1 || ws.Vaults[0].ID != "shared" {
		t.Fatalf("expected shared vault file, got %#v", ws.Vaults)
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
id = "victor"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"
`)
	writeWorkspaceFile(t, root, "agents/b.toml", `[agent]
id = "victor"
fly_app = "tvc-companion-victor-2"
tailscale_hostname = "victor-2"
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
	writeWorkspaceFile(t, root, "agents/victor.toml", `[agent]
id = "victor"
runtime = "fly.missing"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"
`)
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "unknown runtime provider fly.missing") {
		t.Fatalf("expected unknown provider error, got %v", err)
	}
}

func TestLoadFailsOnWrongProviderKind(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "agents/victor.toml", `[agent]
id = "victor"
runtime = "openrouter.default"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"
`)
	_, err := Load(root)
	if err == nil || !strings.Contains(err.Error(), "runtime must reference a fly provider") {
		t.Fatalf("expected provider kind error, got %v", err)
	}
}

func TestLoadFailsOnAbsoluteIdentityPath(t *testing.T) {
	root := t.TempDir()
	writeMinimalWorkspace(t, root)
	writeWorkspaceFile(t, root, "agents/victor.toml", `[agent]
id = "victor"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"
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
	writeWorkspaceFile(t, root, "agents/victor.toml", `[agent]
id = "victor"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"
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

[tailscale.tvc]
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
