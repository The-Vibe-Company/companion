package config

import (
	"testing"
)

func TestNormalizeSampleConfigShape(t *testing.T) {
	cfg, err := Normalize(RawConfig{
		Defaults: RawDefaults{
			APIServer: RawAPIServer{Enabled: boolPtr(true), Host: strPtr("0.0.0.0"), Port: intPtr(8642)},
			Model: RawModel{
				Enabled:          boolPtr(true),
				Provider:         strPtr("openrouter"),
				Default:          strPtr("google/gemini-3.5-flash"),
				BaseURL:          strPtr("https://openrouter.ai/api/v1"),
				APIKeySecretName: strPtr("OPENROUTER_API_KEY"),
				APIKeyEnv:        strPtr("OPENROUTER_API_KEY"),
			},
		},
		OpenWebUI: RawOpenWebUI{Enabled: boolPtr(true), TailscaleAcceptDNS: boolPtr(true)},
		Agents: []RawAgent{
			{ID: strPtr("companion-test"), FlyApp: strPtr("tvc-companion-test"), TailscaleHostname: strPtr("companion-test")},
			{ID: strPtr("companion-lab"), FlyApp: strPtr("tvc-companion-lab"), TailscaleHostname: strPtr("companion-lab")},
			{
				ID:                strPtr("victor"),
				FlyApp:            strPtr("tvc-companion-victor"),
				TailscaleHostname: strPtr("victor"),
				Identity:          RawIdentity{Path: strPtr("identities/victor/SOUL.md")},
			},
			{ID: strPtr("writer"), FlyApp: strPtr("tvc-companion-writer"), TailscaleHostname: strPtr("companion-writer")},
		},
	})
	if err != nil {
		t.Fatalf("normalize sample config: %v", err)
	}
	if len(cfg.Agents) != 4 {
		t.Fatalf("expected 4 agents, got %d", len(cfg.Agents))
	}
	victor := cfg.Agents[2]
	if victor.ID != "victor" {
		t.Fatalf("unexpected third agent: %s", victor.ID)
	}
	if !victor.APIServer.Enabled {
		t.Fatalf("expected api server inherited from defaults")
	}
	if !victor.Identity.Enabled || victor.Identity.Path != "identities/victor/SOUL.md" {
		t.Fatalf("expected victor identity config, got %#v", victor.Identity)
	}
	if !cfg.OpenWebUI.Enabled || !cfg.OpenWebUI.TailscaleAcceptDNS {
		t.Fatalf("expected enabled open webui with tailscale dns")
	}
}

func TestReadSyncCannotExposeWriteMCP(t *testing.T) {
	raw := RawConfig{
		Agents: []RawAgent{{
			ID:                strPtr("agent-a"),
			FlyApp:            strPtr("agent-a"),
			TailscaleHostname: strPtr("agent-a"),
			VaultConnections: []RawVaultConnection{{
				Name:    strPtr("source"),
				Mode:    strPtr("sync"),
				Role:    strPtr("read"),
				MCPRole: strPtr("write"),
				Host:    strPtr("source"),
			}},
		}},
	}
	_, err := Normalize(raw)
	if err == nil {
		t.Fatalf("expected invalid read sync write MCP")
	}
}

func TestOpenWebUIConnectionsSkipDisabledAgent(t *testing.T) {
	cfg, err := Normalize(RawConfig{
		Defaults: RawDefaults{
			APIServer: RawAPIServer{Enabled: boolPtr(true), Port: intPtr(8642)},
		},
		OpenWebUI: RawOpenWebUI{Enabled: boolPtr(true)},
		Agents: []RawAgent{
			{ID: strPtr("agent-a"), FlyApp: strPtr("agent-a"), TailscaleHostname: strPtr("agent-a")},
			{ID: strPtr("agent-b"), FlyApp: strPtr("agent-b"), TailscaleHostname: strPtr("agent-b"), APIServer: RawAPIServer{OpenWebUIEnabled: boolPtr(false)}},
		},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	connections := cfg.OpenWebUIConnections()
	if len(connections) != 1 || connections[0].AgentID != "agent-a" {
		t.Fatalf("unexpected connections: %#v", connections)
	}
}

func TestIdentityDefaultsAndOverrides(t *testing.T) {
	cfg, err := Normalize(RawConfig{
		Defaults: RawDefaults{
			Identity: RawIdentity{Path: strPtr("identities/default/SOUL.md")},
		},
		Agents: []RawAgent{
			{ID: strPtr("agent-a"), FlyApp: strPtr("agent-a"), TailscaleHostname: strPtr("agent-a")},
			{ID: strPtr("agent-b"), FlyApp: strPtr("agent-b"), TailscaleHostname: strPtr("agent-b"), Identity: RawIdentity{
				Soul:      strPtr("You are Agent B."),
				Overwrite: boolPtr(false),
			}},
		},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if !cfg.Agents[0].Identity.Enabled || cfg.Agents[0].Identity.Path != "identities/default/SOUL.md" {
		t.Fatalf("expected inherited identity path, got %#v", cfg.Agents[0].Identity)
	}
	if cfg.Agents[1].Identity.Path != "identities/default/SOUL.md" || cfg.Agents[1].Identity.Soul != "You are Agent B." || cfg.Agents[1].Identity.Overwrite {
		t.Fatalf("expected overridden inline identity, got %#v", cfg.Agents[1].Identity)
	}
}

func TestIdentityRejectsAbsolutePath(t *testing.T) {
	_, err := Normalize(RawConfig{
		Agents: []RawAgent{{
			ID:                strPtr("agent-a"),
			FlyApp:            strPtr("agent-a"),
			TailscaleHostname: strPtr("agent-a"),
			Identity:          RawIdentity{Path: strPtr("/tmp/SOUL.md")},
		}},
	})
	if err == nil {
		t.Fatalf("expected absolute identity path to be rejected")
	}
}

func TestAgentCanDisableInheritedIdentity(t *testing.T) {
	cfg, err := Normalize(RawConfig{
		Defaults: RawDefaults{
			Identity: RawIdentity{Path: strPtr("identities/default/SOUL.md")},
		},
		Agents: []RawAgent{{
			ID:                strPtr("agent-a"),
			FlyApp:            strPtr("agent-a"),
			TailscaleHostname: strPtr("agent-a"),
			Identity:          RawIdentity{Enabled: boolPtr(false)},
		}},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if cfg.Agents[0].Identity.Enabled {
		t.Fatalf("expected agent identity to be disabled, got %#v", cfg.Agents[0].Identity)
	}
}

func TestIdentityEnabledRequiresPathOrSoul(t *testing.T) {
	_, err := Normalize(RawConfig{
		Agents: []RawAgent{{
			ID:                strPtr("agent-a"),
			FlyApp:            strPtr("agent-a"),
			TailscaleHostname: strPtr("agent-a"),
			Identity:          RawIdentity{Enabled: boolPtr(true)},
		}},
	})
	if err == nil {
		t.Fatalf("expected enabled identity without path or soul to be rejected")
	}
}

func strPtr(value string) *string { return &value }
func boolPtr(value bool) *bool    { return &value }
func intPtr(value int) *int       { return &value }
