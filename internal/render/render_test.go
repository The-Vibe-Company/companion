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
		FlyApp:                     "tvc-companion-webui",
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
		ID:                         "victor",
		FlyApp:                     "victor",
		Region:                     "cdg",
		VolumeName:                 "data",
		Memory:                     "1gb",
		CPUs:                       1,
		TailscaleHostname:          "victor",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		DashboardHost:              "0.0.0.0",
		DashboardMode:              "serve",
		DashboardPort:              9119,
		Identity: config.Identity{
			Enabled:   true,
			Soul:      "# Victor\n\nYou are direct.",
			Overwrite: true,
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		`HERMES_IDENTITY_JSON = "{\"enabled\":true`,
		`\"soul\":\"# Victor\\n\\nYou are direct.\"`,
		`\"overwrite\":true}`,
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("missing %q in\n%s", want, toml)
		}
	}
}

func TestAgentRenderOmitsDisabledIdentity(t *testing.T) {
	toml, err := AgentFlyTOML(config.Agent{
		ID:                         "victor",
		FlyApp:                     "victor",
		Region:                     "cdg",
		VolumeName:                 "data",
		Memory:                     "1gb",
		CPUs:                       1,
		TailscaleHostname:          "victor",
		TailscaleAuthKeySecretName: "TS_AUTHKEY",
		DashboardHost:              "0.0.0.0",
		DashboardMode:              "serve",
		DashboardPort:              9119,
		Identity: config.Identity{
			Enabled: false,
			Soul:    "# Should not be rendered",
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(toml, "HERMES_IDENTITY_JSON") || strings.Contains(toml, "Should not be rendered") {
		t.Fatalf("disabled identity leaked into TOML:\n%s", toml)
	}
}
