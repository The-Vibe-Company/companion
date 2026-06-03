package provider

import (
	"fmt"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/workspace"
)

type Registry struct {
	Workspace *workspace.Workspace
	Env       map[string]string
}

type Credential struct {
	Name    string
	Present bool
}

func New(ws *workspace.Workspace, env map[string]string) Registry {
	return Registry{Workspace: ws, Env: env}
}

func (r Registry) RequiredCredentials() []Credential {
	seen := map[string]bool{}
	var credentials []Credential
	add := func(name string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		credentials = append(credentials, Credential{Name: name, Present: r.Env[name] != ""})
	}
	for _, provider := range r.Workspace.Providers.Fly {
		add(provider.TokenEnv)
	}
	for _, provider := range r.Workspace.Providers.Tailscale {
		add(provider.APIKeyEnv)
		add(provider.AuthKeySecret)
	}
	for _, provider := range r.Workspace.Providers.OpenRouter {
		add(provider.APIKeyEnv)
	}
	return credentials
}

func (r Registry) ValidateCredentials(refs ...string) error {
	missing := []string{}
	seen := map[string]bool{}
	addMissing := func(name string) {
		if name != "" && r.Env[name] == "" && !seen[name] {
			seen[name] = true
			missing = append(missing, name)
		}
	}
	for _, ref := range refs {
		kind, name, ok := strings.Cut(ref, ".")
		if !ok {
			return fmt.Errorf("provider ref %s must look like provider.name", ref)
		}
		switch kind {
		case "fly":
			provider, ok := r.Workspace.Providers.Fly[name]
			if !ok {
				return fmt.Errorf("unknown fly provider %s", ref)
			}
			addMissing(provider.TokenEnv)
		case "tailscale":
			provider, ok := r.Workspace.Providers.Tailscale[name]
			if !ok {
				return fmt.Errorf("unknown tailscale provider %s", ref)
			}
			addMissing(provider.APIKeyEnv)
			addMissing(provider.AuthKeySecret)
		case "openrouter":
			provider, ok := r.Workspace.Providers.OpenRouter[name]
			if !ok {
				return fmt.Errorf("unknown openrouter provider %s", ref)
			}
			addMissing(provider.APIKeyEnv)
		default:
			return fmt.Errorf("unknown provider kind %s", kind)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("set %s in .env or your local environment before apply", strings.Join(missing, ", "))
	}
	return nil
}
