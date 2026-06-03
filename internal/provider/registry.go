package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/execx"
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
		if provider.Mode == "api" {
			add(provider.TokenEnv)
		}
	}
	for _, provider := range r.Workspace.Providers.Tailscale {
		if provider.Mode == "api" {
			add(provider.APIKeyEnv)
		}
		add(provider.AuthKeySecret)
	}
	for _, provider := range r.Workspace.Providers.OpenRouter {
		add(provider.APIKeyEnv)
	}
	return credentials
}

func (r Registry) ValidateCredentials(refs ...string) error {
	return r.ValidateCredentialsWithRunner(context.Background(), nil, refs...)
}

func (r Registry) ValidateCredentialsWithRunner(ctx context.Context, runner execx.Runner, refs ...string) error {
	missing := []string{}
	authErrors := []string{}
	seen := map[string]bool{}
	flyCLIChecked := false
	flyCLIOK := false
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
			if provider.Mode == "api" {
				addMissing(provider.TokenEnv)
				break
			}
			if provider.TokenEnv != "" && r.Env[provider.TokenEnv] != "" {
				break
			}
			if !flyCLIChecked {
				flyCLIOK = flyCLIAuthenticated(ctx, runner)
				flyCLIChecked = true
			}
			if !flyCLIOK && len(authErrors) == 0 {
				if provider.TokenEnv != "" {
					authErrors = append(authErrors, fmt.Sprintf("authenticate Fly with fly auth login or set %s", provider.TokenEnv))
				} else {
					authErrors = append(authErrors, "authenticate Fly with fly auth login")
				}
			}
		case "tailscale":
			provider, ok := r.Workspace.Providers.Tailscale[name]
			if !ok {
				return fmt.Errorf("unknown tailscale provider %s", ref)
			}
			if provider.Mode == "api" {
				addMissing(provider.APIKeyEnv)
			}
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
	var parts []string
	if len(missing) > 0 {
		parts = append(parts, fmt.Sprintf("set %s in .env or your local environment", strings.Join(missing, ", ")))
	}
	parts = append(parts, authErrors...)
	if len(parts) > 0 {
		return fmt.Errorf("%s before apply", strings.Join(parts, "; "))
	}
	return nil
}

func flyCLIAuthenticated(ctx context.Context, runner execx.Runner) bool {
	if runner == nil {
		return false
	}
	result, err := runner.Run(ctx, []string{"fly", "auth", "whoami"})
	return err == nil && result.ExitCode == 0
}
