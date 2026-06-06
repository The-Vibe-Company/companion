package provider

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/providertest"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

func TestNewSetBuildsAPIProvidersAndValidatesModels(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.SetOpenRouterModels([]string{"google/gemini-3.5-flash"})
	cfg, err := config.Normalize(config.RawConfig{
		Defaults: config.RawDefaults{
			Model: config.RawModel{Enabled: boolPtr(true), Default: strPtr("google/gemini-3.5-flash")},
		},
		Agents: []config.RawAgent{{
			ID:                strPtr("sample"),
			FlyApp:            strPtr("example-companion-sample"),
			TailscaleHostname: strPtr("sample"),
			ModelProvider:     strPtr("openrouter.default"),
		}},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	ws := &workspace.Workspace{
		Root:      t.TempDir(),
		StatePath: filepath.Join(t.TempDir(), "state.sqlite"),
		Config:    cfg,
		Providers: workspace.Providers{
			Fly: map[string]workspace.FlyProvider{"default": {
				Mode:       "api",
				APIBaseURL: server.FlyBaseURL(),
				TokenEnv:   "FLY_API_TOKEN",
			}},
			Tailscale: map[string]workspace.TailscaleProvider{"default": {
				Mode:       "api",
				APIBaseURL: server.TailscaleBaseURL(),
				Tailnet:    "tail.ts.net",
				APIKeyEnv:  "TAILSCALE_API_KEY",
			}},
			OpenRouter: map[string]workspace.OpenRouterProvider{"default": {
				APIBaseURL: server.OpenRouterBaseURL(),
				APIKeyEnv:  "OPENROUTER_API_KEY",
			}},
		},
	}
	set, err := NewSet(ws, map[string]string{
		"FLY_API_TOKEN":      "fly-token",
		"TAILSCALE_API_KEY":  "ts-token",
		"OPENROUTER_API_KEY": "or-token",
	}, &execx.FakeRunner{})
	if err != nil {
		t.Fatalf("new set: %v", err)
	}
	if _, err := set.FlyFor("fly.default"); err != nil {
		t.Fatalf("fly provider: %v", err)
	}
	if _, err := set.TailscaleFor("tailscale.default"); err != nil {
		t.Fatalf("tailscale provider: %v", err)
	}
	if err := set.ValidateModels(context.Background(), cfg); err != nil {
		t.Fatalf("validate models: %v", err)
	}
}

func TestNewSetUsesDeployContextForRollouts(t *testing.T) {
	workspaceRoot := t.TempDir()
	deployContext := t.TempDir()
	ws := &workspace.Workspace{
		Root: workspaceRoot,
		Providers: workspace.Providers{
			Fly: map[string]workspace.FlyProvider{"default": {Region: "cdg"}},
		},
	}
	set, err := NewSet(ws, map[string]string{"COMPANION_DEPLOY_CONTEXT": deployContext}, execx.ShellRunner{Dir: workspaceRoot})
	if err != nil {
		t.Fatalf("new set: %v", err)
	}
	rollout, ok := set.Rollout["fly.default"].(fly.Provider)
	if !ok {
		t.Fatalf("rollout provider type = %T, want fly.Provider", set.Rollout["fly.default"])
	}
	runner, ok := rollout.Runner.(execx.ShellRunner)
	if !ok {
		t.Fatalf("rollout runner type = %T, want execx.ShellRunner", rollout.Runner)
	}
	if runner.Dir != deployContext {
		t.Fatalf("rollout runner dir = %q, want deploy context %q", runner.Dir, deployContext)
	}
}

func TestValidateModelsReportsMissingModel(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.SetOpenRouterModels([]string{"other/model"})
	cfg, err := config.Normalize(config.RawConfig{
		Defaults: config.RawDefaults{
			Model: config.RawModel{Enabled: boolPtr(true), Default: strPtr("google/gemini-3.5-flash")},
		},
		Agents: []config.RawAgent{{
			ID:                strPtr("sample"),
			FlyApp:            strPtr("example-companion-sample"),
			TailscaleHostname: strPtr("sample"),
			ModelProvider:     strPtr("openrouter.default"),
		}},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	set := Set{OpenRouter: map[string]ModelCatalog{"openrouter.default": testCatalog{false, nil}}}
	err = set.ValidateModels(context.Background(), cfg)
	if err == nil {
		t.Fatalf("expected missing model error")
	}
}

type testCatalog struct {
	ok  bool
	err error
}

func (c testCatalog) HasModel(context.Context, string) (bool, error) {
	return c.ok, c.err
}

func strPtr(value string) *string { return &value }
func boolPtr(value bool) *bool    { return &value }
