package provider

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/openrouter"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

type FlyRuntime interface {
	AppExists(ctx context.Context, app string) (bool, error)
	CreateApp(ctx context.Context, app string) error
	DeleteApp(ctx context.Context, app string) error
	ListVolumes(ctx context.Context, app string) ([]fly.Volume, error)
	EnsureVolume(ctx context.Context, app, name, region string, sizeGB int) (string, error)
	DeleteVolume(ctx context.Context, app, volumeID string) error
	SecretNames(ctx context.Context, app string) (map[string]bool, error)
	SetSecrets(ctx context.Context, app string, secrets map[string]string) error
	ListMachines(ctx context.Context, app string) ([]fly.Machine, error)
}

type RolloutRunner interface {
	Deploy(ctx context.Context, app, configPath string) error
}

type TailscaleNetwork interface {
	Devices(ctx context.Context) ([]tailscale.Device, error)
}

type ModelCatalog interface {
	HasModel(ctx context.Context, id string) (bool, error)
}

type Set struct {
	Fly        map[string]FlyRuntime
	Rollout    map[string]RolloutRunner
	Tailscale  map[string]TailscaleNetwork
	OpenRouter map[string]ModelCatalog
}

func NewSet(ws *workspace.Workspace, env map[string]string, runner execx.Runner) (Set, error) {
	if runner == nil {
		runner = execx.ShellRunner{Dir: ws.Root, Env: env}
	}
	set := Set{
		Fly:        map[string]FlyRuntime{},
		Rollout:    map[string]RolloutRunner{},
		Tailscale:  map[string]TailscaleNetwork{},
		OpenRouter: map[string]ModelCatalog{},
	}
	for name, cfg := range ws.Providers.Fly {
		ref := "fly." + name
		shell := fly.NewWithOrg(runner, cfg.Org)
		if cfg.Mode == "api" {
			set.Fly[ref] = fly.NewAPI(cfg.APIBaseURL, env[cfg.TokenEnv], cfg.Org)
		} else {
			set.Fly[ref] = shell
		}
		set.Rollout[ref] = shell
	}
	for name, cfg := range ws.Providers.Tailscale {
		ref := "tailscale." + name
		if cfg.Mode == "api" {
			set.Tailscale[ref] = tailscale.NewAPI(cfg.APIBaseURL, env[cfg.APIKeyEnv], cfg.Tailnet)
		} else {
			set.Tailscale[ref] = tailscale.New(runner)
		}
	}
	for name, cfg := range ws.Providers.OpenRouter {
		ref := "openrouter." + name
		set.OpenRouter[ref] = openrouter.New(firstNonEmpty(cfg.APIBaseURL, cfg.BaseURL), env[cfg.APIKeyEnv])
	}
	return set, nil
}

func Static(flyProvider FlyRuntime, tsProvider TailscaleNetwork, rollout RolloutRunner) Set {
	return Set{
		Fly:        map[string]FlyRuntime{"fly.default": flyProvider},
		Rollout:    map[string]RolloutRunner{"fly.default": rollout},
		Tailscale:  map[string]TailscaleNetwork{"tailscale.default": tsProvider},
		OpenRouter: map[string]ModelCatalog{},
	}
}

func (s Set) FlyFor(ref string) (FlyRuntime, error) {
	if provider, ok := s.Fly[ref]; ok {
		return provider, nil
	}
	if ref == "" && len(s.Fly) == 1 {
		for _, provider := range s.Fly {
			return provider, nil
		}
	}
	return nil, fmt.Errorf("fly provider %s is not configured", ref)
}

func (s Set) RolloutFor(ref string) (RolloutRunner, error) {
	if provider, ok := s.Rollout[ref]; ok {
		return provider, nil
	}
	if ref == "" && len(s.Rollout) == 1 {
		for _, provider := range s.Rollout {
			return provider, nil
		}
	}
	return nil, fmt.Errorf("rollout provider %s is not configured", ref)
}

func (s Set) TailscaleFor(ref string) (TailscaleNetwork, error) {
	if provider, ok := s.Tailscale[ref]; ok {
		return provider, nil
	}
	if ref == "" && len(s.Tailscale) == 1 {
		for _, provider := range s.Tailscale {
			return provider, nil
		}
	}
	return nil, fmt.Errorf("tailscale provider %s is not configured", ref)
}

func (s Set) OpenRouterFor(ref string) (ModelCatalog, error) {
	if provider, ok := s.OpenRouter[ref]; ok {
		return provider, nil
	}
	return nil, fmt.Errorf("openrouter provider %s is not configured", ref)
}

func (s Set) Devices(ctx context.Context, ref string) ([]tailscale.Device, error) {
	provider, err := s.TailscaleFor(ref)
	if err != nil {
		return nil, err
	}
	return provider.Devices(ctx)
}

func (s Set) AllDevices(ctx context.Context) ([]tailscale.Device, error) {
	refs := make([]string, 0, len(s.Tailscale))
	for ref := range s.Tailscale {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	var devices []tailscale.Device
	for _, ref := range refs {
		items, err := s.Tailscale[ref].Devices(ctx)
		if err != nil {
			return nil, err
		}
		devices = append(devices, items...)
	}
	return devices, nil
}

func (s Set) ValidateModels(ctx context.Context, cfg *config.Config) error {
	checked := map[string]bool{}
	for _, agent := range cfg.Agents {
		model := strings.TrimSpace(agent.Model.Default)
		if !agent.Model.Enabled || model == "" {
			continue
		}
		key := agent.ModelProvider + "\x00" + model
		if checked[key] {
			continue
		}
		catalog, err := s.OpenRouterFor(agent.ModelProvider)
		if err != nil {
			return err
		}
		ok, err := catalog.HasModel(ctx, model)
		if err != nil {
			return fmt.Errorf("validate model %s for agent %s: %w", model, agent.ID, err)
		}
		if !ok {
			return fmt.Errorf("model %s for agent %s was not found in %s", model, agent.ID, agent.ModelProvider)
		}
		checked[key] = true
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
