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
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestImportAndStateListCommands(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.sqlite")

	importCmd := NewRootCommand()
	importCmd.SetArgs([]string{"--state", statePath, "import", "fly_app.companion-test", "tvc-companion-test", "--attrs", "region=cdg"})
	if err := importCmd.Execute(); err != nil {
		t.Fatalf("import command: %v", err)
	}

	listCmd := NewRootCommand()
	var output bytes.Buffer
	listCmd.SetOut(&output)
	listCmd.SetArgs([]string{"--state", statePath, "state", "list"})
	if err := listCmd.Execute(); err != nil {
		t.Fatalf("state list command: %v", err)
	}
	if !strings.Contains(output.String(), "fly_app.companion-test -> tvc-companion-test") {
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

func TestRecordAgentResourcesUpsertsObservedState(t *testing.T) {
	store, err := state.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	defer store.Close()

	flyRunner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly volumes list -a tvc-companion-victor --json": {Stdout: `[{
			"id":"vol_victor",
			"name":"data",
			"state":"created",
			"size_gb":3,
			"region":"cdg",
			"attached_machine_id":"machine_victor"
		}]`},
	}}
	tsRunner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{"node:1":{
			"ID":"node_1",
			"HostName":"victor",
			"DNSName":"victor.tailnet.ts.net.",
			"Online":true,
			"TailscaleIPs":["100.64.0.10"]
		}}}`},
	}}

	agent := config.Agent{
		ID:                "victor",
		FlyApp:            "tvc-companion-victor",
		TailscaleHostname: "victor",
		Region:            "cdg",
		VolumeName:        "data",
		VolumeSizeGB:      3,
		Memory:            "4gb",
		CPUs:              2,
	}
	if err := recordAgentResources(context.Background(), store, fly.New(flyRunner), tailscale.New(tsRunner), agent, ".companion/generated/fly.victor.toml"); err != nil {
		t.Fatalf("record agent resources: %v", err)
	}

	resources, err := store.ListResources(context.Background())
	if err != nil {
		t.Fatalf("list resources: %v", err)
	}
	if len(resources) != 3 {
		t.Fatalf("expected app, volume, and tailscale device, got %#v", resources)
	}
	seen := map[string]string{}
	for _, resource := range resources {
		seen[resource.Provider+"_"+resource.Kind+"."+resource.DesiredID] = resource.ExternalID
		if strings.Contains(resource.AttrsJSON, "secret") {
			t.Fatalf("state attrs should not contain secrets: %#v", resource)
		}
	}
	if seen["fly_app.victor"] != "tvc-companion-victor" {
		t.Fatalf("missing fly app resource: %#v", seen)
	}
	if seen["fly_volume.victor-data"] != "vol_victor" {
		t.Fatalf("missing fly volume resource: %#v", seen)
	}
	if seen["tailscale_device.victor"] != "node_1" {
		t.Fatalf("missing tailscale device resource: %#v", seen)
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

func TestIdentityInitAndRenderCommands(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "companion.toml")
	if err := os.WriteFile(configPath, []byte(`
[[agents]]
id = "victor"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"

[agents.default_vault]
name = "Victor"
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	initCmd := NewRootCommand()
	initCmd.SetArgs([]string{"--root", root, "--config", configPath, "identity", "init", "victor", "--name", "Victor"})
	if err := initCmd.Execute(); err != nil {
		t.Fatalf("identity init: %v", err)
	}

	identityPath := filepath.Join(root, "identities", "victor", "SOUL.md")
	data, err := os.ReadFile(identityPath)
	if err != nil {
		t.Fatalf("read identity file: %v", err)
	}
	if !strings.Contains(string(data), "You are Victor") {
		t.Fatalf("unexpected identity file: %s", string(data))
	}
	configData, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	for _, want := range []string{
		"[agents.identity]",
		`path = "identities/victor/SOUL.md"`,
		"overwrite = true",
	} {
		if !strings.Contains(string(configData), want) {
			t.Fatalf("config missing %q:\n%s", want, string(configData))
		}
	}

	renderCmd := NewRootCommand()
	var output bytes.Buffer
	renderCmd.SetOut(&output)
	renderCmd.SetArgs([]string{"--root", root, "--config", configPath, "identity", "render", "victor"})
	if err := renderCmd.Execute(); err != nil {
		t.Fatalf("identity render: %v", err)
	}
	if !strings.Contains(output.String(), "You are Victor") {
		t.Fatalf("unexpected render output: %s", output.String())
	}
}

func TestHydrateAgentIdentityReadsRelativePath(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "identities", "victor", "SOUL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir identity dir: %v", err)
	}
	if err := os.WriteFile(path, []byte("# Victor\n\nYou are Victor.\n"), 0o644); err != nil {
		t.Fatalf("write identity: %v", err)
	}

	agent, err := (&app{rootDir: root}).hydrateAgentIdentity(config.Agent{
		ID: "victor",
		Identity: config.Identity{
			Enabled:   true,
			Path:      "identities/victor/SOUL.md",
			Overwrite: true,
		},
	})
	if err != nil {
		t.Fatalf("hydrate identity: %v", err)
	}
	if agent.Identity.Soul != "# Victor\n\nYou are Victor.\n" {
		t.Fatalf("unexpected hydrated soul: %q", agent.Identity.Soul)
	}
}

func TestIdentityRenderErrorsWhenFileIsMissing(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "companion.toml")
	if err := os.WriteFile(configPath, []byte(`
[[agents]]
id = "victor"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"

[agents.identity]
enabled = true
path = "identities/victor/SOUL.md"
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cmd := NewRootCommand()
	cmd.SetArgs([]string{"--root", root, "--config", configPath, "identity", "render", "victor"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected missing identity file error")
	}
	if !strings.Contains(err.Error(), "read identity for agent victor") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestUpdateAgentIdentityConfigReplacesOnlyTargetAgent(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "companion.toml")
	if err := os.WriteFile(configPath, []byte(`
[[agents]]
id = "companion-test"
fly_app = "tvc-companion-test"
tailscale_hostname = "companion-test"

[agents.identity]
enabled = true
path = "identities/companion-test/SOUL.md"
overwrite = true

[[agents]]
id = "victor"
fly_app = "tvc-companion-victor"
tailscale_hostname = "victor"

[agents.identity]
enabled = true
path = "old/victor/SOUL.md"
overwrite = true

[agents.default_vault]
name = "Victor"
`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if err := updateAgentIdentityConfig(configPath, "victor", "identities/victor/SOUL.md", false); err != nil {
		t.Fatalf("update identity config: %v", err)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("load updated config: %v", err)
	}
	test, err := selectSingleAgent(cfg, "companion-test")
	if err != nil {
		t.Fatalf("select companion-test: %v", err)
	}
	if test.Identity.Path != "identities/companion-test/SOUL.md" || !test.Identity.Overwrite {
		t.Fatalf("unexpected companion-test identity: %#v", test.Identity)
	}
	victor, err := selectSingleAgent(cfg, "victor")
	if err != nil {
		t.Fatalf("select victor: %v", err)
	}
	if victor.Identity.Path != "identities/victor/SOUL.md" || victor.Identity.Overwrite {
		t.Fatalf("unexpected victor identity: %#v", victor.Identity)
	}
	if victor.DefaultVault.Name != "Victor" {
		t.Fatalf("expected default vault table to be preserved, got %#v", victor.DefaultVault)
	}
}
