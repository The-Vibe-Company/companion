package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/render"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

func TestImportAndStateListCommands(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"example-peer": `
[agent]
id = "example-peer"
fly_app = "example-peer-app"
tailscale_hostname = "example-peer"
`,
	})

	importCmd := NewRootCommand()
	importCmd.SetArgs([]string{"--workspace", root, "import", "fly_app.agent.example-peer", "example-peer-app", "--attrs", "region=cdg"})
	if err := importCmd.Execute(); err != nil {
		t.Fatalf("import command: %v", err)
	}

	listCmd := NewRootCommand()
	var output bytes.Buffer
	listCmd.SetOut(&output)
	listCmd.SetArgs([]string{"--workspace", root, "state", "list"})
	if err := listCmd.Execute(); err != nil {
		t.Fatalf("state list command: %v", err)
	}
	if !strings.Contains(output.String(), "fly_app.agent.example-peer -> example-peer-app") {
		t.Fatalf("unexpected state output: %s", output.String())
	}
}

func TestAgentSecretsCanReuseExistingFlySecrets(t *testing.T) {
	agent := config.Agent{
		FlyApp:                     "app",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		Model: config.Model{
			Enabled:          true,
			APIKeySecretName: "OPENROUTER_API_KEY",
		},
		APIServer: config.APIServer{
			Enabled:       true,
			KeySecretName: "API_SERVER_KEY",
		},
	}
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly secrets list -a app --json": {Stdout: `[{"name":"TS_AUTHKEY"},{"name":"OPENROUTER_API_KEY"},{"name":"API_SERVER_KEY"}]`},
	}}
	values, reused, err := agentSecrets(context.Background(), fly.New(runner), agent, true, map[string]string{})
	if err != nil {
		t.Fatalf("agent secrets: %v", err)
	}
	if len(values) != 0 {
		t.Fatalf("expected no local secret values, got %#v", values)
	}
	if strings.Join(reused, ",") != strings.Join(render.RequiredAgentSecrets(agent), ",") {
		t.Fatalf("unexpected reused secrets: %#v", reused)
	}
}

func TestOpenWebUISecretsCanPartiallyReuseExistingFlySecrets(t *testing.T) {
	cfg := config.OpenWebUI{
		FlyApp:                     "webui",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		WebUISecretKeySecretName:   "WEBUI_SECRET_KEY",
		OpenAIAPIKeysSecretName:    "OPENAI_API_KEYS",
	}
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly secrets list -a webui --json": {Stdout: `[{"name":"TS_AUTHKEY"},{"name":"WEBUI_SECRET_KEY"}]`},
	}}
	values, err := openWebUISecrets(context.Background(), fly.New(runner), cfg, []config.OpenWebUIConnection{
		{KeySecretName: "API_SERVER_KEY"},
		{KeySecretName: "API_SERVER_KEY"},
	}, true, map[string]string{"API_SERVER_KEY": "shared-api-key"})
	if err != nil {
		t.Fatalf("open webui secrets: %v", err)
	}
	if values["OPENAI_API_KEYS"] != "shared-api-key;shared-api-key" {
		t.Fatalf("unexpected aggregate keys: %#v", values)
	}
	if values["TS_AUTHKEY"] != "" || values["WEBUI_SECRET_KEY"] != "" {
		t.Fatalf("expected reused webui secrets to be omitted from set values: %#v", values)
	}
}

func TestAppEnvLoadsEnvFileAndShellOverrides(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("API_SERVER_KEY=file-value\nOPENROUTER_API_KEY='quoted-value'\n"), 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}
	t.Setenv("API_SERVER_KEY", "shell-value")

	values, err := (&app{rootDir: root, envFile: ".env"}).env()
	if err != nil {
		t.Fatalf("load env: %v", err)
	}
	if values["API_SERVER_KEY"] != "shell-value" {
		t.Fatalf("expected shell value to override .env, got %q", values["API_SERVER_KEY"])
	}
	if values["OPENROUTER_API_KEY"] != "quoted-value" {
		t.Fatalf("expected quoted .env value, got %q", values["OPENROUTER_API_KEY"])
	}
}

func TestPlanCommandDoesNotPrintSecretValues(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"sample": `
[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`,
	})
	writeTestFile(t, root, ".env", `
TS_AUTHKEY = "tailscale-auth-secret"
API_SERVER_KEY = "api-server-secret"
FLY_API_TOKEN = "fly-token-secret"
TAILSCALE_API_KEY = "tailscale-api-secret"
`)
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{}}`},
	}}
	cmd := newRootCommand(runner)
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--workspace", root, "--env-file", ".env", "plan"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("plan command: %v", err)
	}
	for _, secretValue := range []string{"tailscale-auth-secret", "api-server-secret", "fly-token-secret", "tailscale-api-secret"} {
		if strings.Contains(output.String(), secretValue) {
			t.Fatalf("plan output leaked secret value %q:\n%s", secretValue, output.String())
		}
	}
	for _, secretName := range []string{"TS_AUTHKEY", "API_SERVER_KEY"} {
		if !strings.Contains(output.String(), secretName) {
			t.Fatalf("plan output should mention missing/reused secret name %q, got:\n%s", secretName, output.String())
		}
	}
}

func TestValidateProvidersRequiresCredentials(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"sample": `
[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`,
	})
	for _, key := range []string{"FLY_API_TOKEN", "TAILSCALE_API_KEY", "TS_AUTHKEY", "OPENROUTER_API_KEY"} {
		t.Setenv(key, "")
	}
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly auth whoami": {ExitCode: 1},
	}}
	cmd := newRootCommand(runner)
	cmd.SetArgs([]string{"--workspace", root, "validate", "--providers"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected missing credential error")
	}
	if !strings.Contains(err.Error(), "fly auth login") || !strings.Contains(err.Error(), "TS_AUTHKEY") || !strings.Contains(err.Error(), "OPENROUTER_API_KEY") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateProvidersAcceptsFlyCLIAuth(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"sample": `
[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`,
	})
	for _, key := range []string{"FLY_API_TOKEN", "TAILSCALE_API_KEY"} {
		t.Setenv(key, "")
	}
	t.Setenv("TS_AUTHKEY", "tailscale-auth-key")
	t.Setenv("OPENROUTER_API_KEY", "openrouter-key")
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly auth whoami": {Stdout: "developer@example.test\n"},
	}}
	cmd := newRootCommand(runner)
	cmd.SetArgs([]string{"--workspace", root, "validate", "--providers"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("validate providers: %v", err)
	}
}

func TestValidateProvidersRequiresFlyTokenInAPIMode(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"sample": `
[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
`,
	})
	writeTestFile(t, root, "providers.toml", `[fly.default]
mode = "api"
region = "cdg"
token_env = "FLY_API_TOKEN"

[tailscale.default]
tailnet = "tailnet.ts.net"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
`)
	for _, key := range []string{"FLY_API_TOKEN", "TAILSCALE_API_KEY"} {
		t.Setenv(key, "")
	}
	t.Setenv("TS_AUTHKEY", "tailscale-auth-key")
	t.Setenv("OPENROUTER_API_KEY", "openrouter-key")
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly auth whoami": {Stdout: "developer@example.test\n"},
	}}
	cmd := newRootCommand(runner)
	cmd.SetArgs([]string{"--workspace", root, "validate", "--providers"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected missing API token error")
	}
	if !strings.Contains(err.Error(), "FLY_API_TOKEN") {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runner.Calls) != 0 {
		t.Fatalf("api mode should not use fly cli auth, got %#v", runner.Calls)
	}
}

func TestIdentityInitAndRenderCommands(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"sample": `
[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"

[default_vault]
name = "Sample Agent"
`,
	})

	initCmd := NewRootCommand()
	initCmd.SetArgs([]string{"--workspace", root, "identity", "init", "sample", "--name", "Sample Agent"})
	if err := initCmd.Execute(); err != nil {
		t.Fatalf("identity init: %v", err)
	}

	identityPath := filepath.Join(root, "identities", "sample", "SOUL.md")
	data, err := os.ReadFile(identityPath)
	if err != nil {
		t.Fatalf("read identity file: %v", err)
	}
	if !strings.Contains(string(data), "You are Sample Agent") {
		t.Fatalf("unexpected identity file: %s", string(data))
	}
	agentData, err := os.ReadFile(filepath.Join(root, "agents", "sample.toml"))
	if err != nil {
		t.Fatalf("read agent config: %v", err)
	}
	for _, want := range []string{`identity = "identities/sample/SOUL.md"`} {
		if !strings.Contains(string(agentData), want) {
			t.Fatalf("agent config missing %q:\n%s", want, string(agentData))
		}
	}

	renderCmd := NewRootCommand()
	var output bytes.Buffer
	renderCmd.SetOut(&output)
	renderCmd.SetArgs([]string{"--workspace", root, "identity", "render", "sample"})
	if err := renderCmd.Execute(); err != nil {
		t.Fatalf("identity render: %v", err)
	}
	if !strings.Contains(output.String(), "You are Sample Agent") {
		t.Fatalf("unexpected render output: %s", output.String())
	}
}

func TestHydrateAgentIdentityReadsRelativePath(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "identities", "sample", "SOUL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir identity dir: %v", err)
	}
	if err := os.WriteFile(path, []byte("# Sample Agent\n\nYou are Sample Agent.\n"), 0o644); err != nil {
		t.Fatalf("write identity: %v", err)
	}

	agent, err := (&app{rootDir: root}).hydrateAgentIdentity(config.Agent{
		ID: "sample",
		Identity: config.Identity{
			Enabled:   true,
			Path:      "identities/sample/SOUL.md",
			Overwrite: true,
		},
	})
	if err != nil {
		t.Fatalf("hydrate identity: %v", err)
	}
	if agent.Identity.Soul != "# Sample Agent\n\nYou are Sample Agent.\n" {
		t.Fatalf("unexpected hydrated soul: %q", agent.Identity.Soul)
	}
}

func TestIdentityRenderErrorsWhenFileIsMissing(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"sample": `
[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
identity = "identities/sample/SOUL.md"
`,
	})

	cmd := NewRootCommand()
	cmd.SetArgs([]string{"--workspace", root, "identity", "render", "sample"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected missing identity file error")
	}
	if !strings.Contains(err.Error(), "read identity for agent sample") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestUpdateAgentIdentityConfigReplacesOnlyTargetAgent(t *testing.T) {
	root := t.TempDir()
	writeTestWorkspace(t, root, map[string]string{
		"example-peer": `
[agent]
id = "example-peer"
fly_app = "example-peer-app"
tailscale_hostname = "example-peer"
identity = "identities/example-peer/SOUL.md"

[identity]
overwrite = true
`,
		"sample": `
[agent]
id = "sample"
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
identity = "old/sample/SOUL.md"

[identity]
overwrite = true

[default_vault]
name = "Sample Agent"
`,
	})

	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if err := updateAgentIdentityConfig(ws, "sample", "identities/sample/SOUL.md", false); err != nil {
		t.Fatalf("update identity config: %v", err)
	}
	updated, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("load updated config: %v", err)
	}
	test, err := selectSingleAgent(updated.Config, "example-peer")
	if err != nil {
		t.Fatalf("select example-peer: %v", err)
	}
	if test.Identity.Path != "identities/example-peer/SOUL.md" || !test.Identity.Overwrite {
		t.Fatalf("unexpected example-peer identity: %#v", test.Identity)
	}
	sample, err := selectSingleAgent(updated.Config, "sample")
	if err != nil {
		t.Fatalf("select sample: %v", err)
	}
	if sample.Identity.Path != "identities/sample/SOUL.md" || sample.Identity.Overwrite {
		t.Fatalf("unexpected sample identity: %#v", sample.Identity)
	}
	if sample.DefaultVault.Name != "Sample Agent" {
		t.Fatalf("expected default vault table to be preserved, got %#v", sample.DefaultVault)
	}
}

func writeTestWorkspace(t *testing.T, root string, agents map[string]string) {
	t.Helper()
	files := map[string]string{
		"companion.toml": `workspace = "test-companion"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
`,
		"providers.toml": `[fly.default]
region = "cdg"
token_env = "FLY_API_TOKEN"

[tailscale.default]
tailnet = "tailnet.ts.net"
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
`,
		"defaults.toml": `[defaults]
region = "cdg"

[defaults.model]
enabled = false

[defaults.api_server]
enabled = true
open_webui_enabled = true
`,
		"webui.toml": `[open_webui]
enabled = false
`,
	}
	for path, content := range files {
		writeTestFile(t, root, path, content)
	}
	for id, content := range agents {
		writeTestFile(t, root, filepath.Join("agents", id+".toml"), content)
	}
}

func writeTestFile(t *testing.T, root, path, content string) {
	t.Helper()
	fullPath := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(fullPath, []byte(strings.TrimSpace(content)+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
