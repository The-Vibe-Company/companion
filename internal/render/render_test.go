package render

import (
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
)

func TestOpenWebUIRenderMultipleBackends(t *testing.T) {
	cfg := config.OpenWebUI{
		Enabled:                    true,
		ID:                         "open-webui",
		FlyApp:                     "example-companion-webui",
		TailscaleHostname:          "companion-webui",
		Region:                     "cdg",
		VolumeName:                 "open_webui_data",
		VolumeSizeGB:               5,
		Memory:                     "4gb",
		CPUs:                       2,
		Port:                       8080,
		Name:                       "Companion",
		TailscaleServe:             true,
		TailscaleAcceptDNS:         true,
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		WebUISecretKeySecretName:   "WEBUI_SECRET_KEY",
		OpenAIAPIKeysSecretName:    "OPENAI_API_KEYS",
	}
	toml, err := OpenWebUIFlyTOML(cfg, []config.OpenWebUIConnection{
		{AgentID: "one", ModelName: "one", URL: "http://one:8642/v1", KeySecretName: "ONE_KEY"},
		{AgentID: "two", ModelName: "two", URL: "http://two:8642/v1", KeySecretName: "TWO_KEY"},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		`OPENAI_API_BASE_URLS = "http://one:8642/v1;http://two:8642/v1"`,
		`OPEN_WEBUI_CONNECTIONS_JSON = "[{\"agent_id\":\"one\"`,
		`TS_ACCEPT_DNS = "true"`,
		`dockerfile = "../../Dockerfile.open-webui"`,
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("missing %q in\n%s", want, toml)
		}
	}
}

func TestDashboardRenderSmallestStatelessMachine(t *testing.T) {
	cfg := config.Dashboard{
		Enabled:                    true,
		ID:                         "dashboard",
		FlyApp:                     "example-companion-dashboard",
		TailscaleHostname:          "companion-dashboard",
		Region:                     "cdg",
		Memory:                     "256mb",
		CPUs:                       1,
		Port:                       9300,
		Name:                       "Companion",
		RefreshInterval:            30,
		TailscaleServe:             true,
		TailscaleAcceptDNS:         true,
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		FlyTokenSecretName:         "FLY_API_TOKEN",
		TailscaleAPIKeySecretName:  "TAILSCALE_API_KEY",
	}
	toml, err := DashboardFlyTOML(cfg)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		`dockerfile = "../../Dockerfile.dashboard"`,
		`memory = "256mb"`,
		"cpus = 1",
		`cpu_kind = "shared"`,
		`COMPANION_FLEET_MANIFEST = "/workspace/fleet.json"`,
		"companion dashboard --manifest /workspace/fleet.json --interval 30s",
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("missing %q in\n%s", want, toml)
		}
	}
	if strings.Contains(toml, "[[mounts]]") {
		t.Fatalf("dashboard must be stateless (no [[mounts]]):\n%s", toml)
	}
	if strings.Contains(toml, "[http_service]") {
		t.Fatalf("dashboard must be tailnet-only (no Fly http_service):\n%s", toml)
	}
	if !strings.Contains(toml, "[[vm]]") {
		t.Fatalf("dashboard must declare a [[vm]] sizing block:\n%s", toml)
	}

	// Optional Tailscale tuning args propagate into the [env] block.
	cfg.TSExtraArgs = "--netfilter-mode=off"
	cfg.TailscaledExtraArgs = "--tun=userspace-networking"
	toml, err = DashboardFlyTOML(cfg)
	if err != nil {
		t.Fatalf("render with extra args: %v", err)
	}
	for _, want := range []string{
		`TS_EXTRA_ARGS = "--netfilter-mode=off"`,
		`TAILSCALED_EXTRA_ARGS = "--tun=userspace-networking"`,
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("missing %q in\n%s", want, toml)
		}
	}

	secrets := RequiredDashboardFlySecrets(cfg)
	for _, name := range []string{"TS_AUTHKEY", "FLY_API_TOKEN", "TAILSCALE_API_KEY"} {
		if !containsString(secrets, name) {
			t.Fatalf("expected required secret %q in %v", name, secrets)
		}
	}
}

func containsString(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}

func TestSecretValuesRedactedSeparately(t *testing.T) {
	cfg := config.OpenWebUI{
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		WebUISecretKeySecretName:   "WEBUI_SECRET_KEY",
		OpenAIAPIKeysSecretName:    "OPENAI_API_KEYS",
	}
	values, err := OpenWebUISecretValues(cfg, []config.OpenWebUIConnection{
		{KeySecretName: "API_SERVER_KEY"},
	}, map[string]string{
		"TS_AUTHKEY":       "secret-ts",
		"WEBUI_SECRET_KEY": "secret-webui",
		"API_SERVER_KEY":   "secret-api",
	})
	if err != nil {
		t.Fatalf("values: %v", err)
	}
	if values["OPENAI_API_KEYS"] != "secret-api" || values["OPENAI_API_KEY"] != "secret-api" {
		t.Fatalf("unexpected openai key aggregation: %#v", values)
	}
}

func TestAgentRenderUsesEmptyVaultConnectionArray(t *testing.T) {
	toml, err := AgentFlyTOML(config.Agent{
		ID:                         "agent",
		FlyApp:                     "agent",
		Region:                     "cdg",
		VolumeName:                 "data",
		Memory:                     "1gb",
		CPUs:                       1,
		TailscaleHostname:          "agent",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		DashboardHost:              "0.0.0.0",
		DashboardMode:              "serve",
		DashboardPort:              9119,
		Model:                      config.Model{Enabled: true},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		`dockerfile = "../../Dockerfile"`,
		`GRANITE_VAULT_CONNECTIONS_JSON = "[]"`,
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("missing %q in\n%s", want, toml)
		}
	}
}

func TestAgentRenderIncludesIdentityJSON(t *testing.T) {
	toml, err := AgentFlyTOML(config.Agent{
		ID:                         "sample",
		FlyApp:                     "sample",
		Region:                     "cdg",
		VolumeName:                 "data",
		Memory:                     "1gb",
		CPUs:                       1,
		TailscaleHostname:          "sample",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		DashboardHost:              "0.0.0.0",
		DashboardMode:              "serve",
		DashboardPort:              9119,
		Identity: config.Identity{
			Enabled:   true,
			Soul:      "# Sample Agent\n\nYou are direct.",
			Overwrite: true,
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		`HERMES_IDENTITY_JSON = "{\"enabled\":true`,
		`\"soul\":\"# Sample Agent\\n\\nYou are direct.\"`,
		`\"overwrite\":true}`,
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("missing %q in\n%s", want, toml)
		}
	}
}

func TestAgentRenderAppendsCompanionSoulToIdentityJSON(t *testing.T) {
	toml, err := AgentFlyTOML(config.Agent{
		ID:                         "sample",
		FlyApp:                     "sample",
		Region:                     "cdg",
		VolumeName:                 "data",
		Memory:                     "1gb",
		CPUs:                       1,
		TailscaleHostname:          "sample",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		DashboardHost:              "0.0.0.0",
		DashboardMode:              "serve",
		DashboardPort:              9119,
		Identity: config.Identity{
			Enabled:   true,
			Soul:      "# Sample Agent\n\nYou are direct.\n",
			Overwrite: true,
		},
		CompanionSoul: config.CompanionSoul{
			Enabled: true,
			Text:    "## Companion Memory\n\nAlways capture durable knowledge in Granite.\n",
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want := `\"soul\":\"# Sample Agent\\n\\nYou are direct.\\n\\n## Companion Memory\\n\\nAlways capture durable knowledge in Granite.\"`
	if !strings.Contains(toml, want) {
		t.Fatalf("companion soul was not appended after identity, missing %q in\n%s", want, toml)
	}
}

func TestAgentRenderCreatesIdentityFromCompanionSoul(t *testing.T) {
	toml, err := AgentFlyTOML(config.Agent{
		ID:                         "sample",
		FlyApp:                     "sample",
		Region:                     "cdg",
		VolumeName:                 "data",
		Memory:                     "1gb",
		CPUs:                       1,
		TailscaleHostname:          "sample",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		DashboardHost:              "0.0.0.0",
		DashboardMode:              "serve",
		DashboardPort:              9119,
		CompanionSoul: config.CompanionSoul{
			Enabled: true,
			Text:    "## Companion Memory\n\nAlways capture durable knowledge in Granite.",
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		`HERMES_IDENTITY_JSON = "{\"enabled\":true`,
		`\"soul\":\"## Companion Memory\\n\\nAlways capture durable knowledge in Granite.\"`,
		`\"overwrite\":true}`,
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("missing %q in\n%s", want, toml)
		}
	}
}

func TestAgentRenderOmitsDisabledIdentity(t *testing.T) {
	toml, err := AgentFlyTOML(config.Agent{
		ID:                         "sample",
		FlyApp:                     "sample",
		Region:                     "cdg",
		VolumeName:                 "data",
		Memory:                     "1gb",
		CPUs:                       1,
		TailscaleHostname:          "sample",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		DashboardHost:              "0.0.0.0",
		DashboardMode:              "serve",
		DashboardPort:              9119,
		Identity: config.Identity{
			Enabled: false,
			Soul:    "# Should not be rendered",
		},
		CompanionSoul: config.CompanionSoul{
			Enabled: false,
			Text:    "# Should not be rendered either",
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(toml, "HERMES_IDENTITY_JSON") || strings.Contains(toml, "Should not be rendered") {
		t.Fatalf("disabled identity leaked into TOML:\n%s", toml)
	}
}
