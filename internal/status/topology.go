// Package status builds a live operational snapshot of a Companion fleet and
// the topology manifest the deployed dashboard polls.
//
// The topology is a small, non-secret artifact ("fleet.json") describing only
// what to poll: per-service Fly app, Tailscale hostname, resolved health URL,
// and the minimal provider info needed to reach the Fly/Tailscale APIs. It is
// the single source of truth shared by local mode (derived live from the
// workspace) and deployed mode (loaded from the generated manifest). Because it
// contains hostnames/ports/URLs only and never secret values, apply can
// regenerate it, ship it, and hash it to gate redeploys.
package status

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/deps"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

// Target is one service the dashboard polls.
type Target struct {
	ID                string `json:"id"`
	Kind              string `json:"kind"` // "agent" | "openwebui"
	FlyApp            string `json:"fly_app,omitempty"`
	ProviderRef       string `json:"provider_ref,omitempty"`
	TailscaleHostname string `json:"tailscale_hostname,omitempty"`
	URL               string `json:"url,omitempty"`
	HealthURL         string `json:"health_url,omitempty"`
	Model             string `json:"model,omitempty"`
	Vault             string `json:"vault,omitempty"`
}

// ProviderSummary carries the minimal, non-secret provider coordinates the
// deployed dashboard needs to build read-only Fly/Tailscale API clients. The
// secret values themselves arrive via the named environment variables (Fly
// secrets on the deployed machine).
type ProviderSummary struct {
	FlyOrg              string `json:"fly_org,omitempty"`
	FlyAPIBaseURL       string `json:"fly_api_base_url,omitempty"`
	FlyTokenEnv         string `json:"fly_token_env,omitempty"`
	Tailnet             string `json:"tailnet,omitempty"`
	TailscaleAPIBaseURL string `json:"tailscale_api_base_url,omitempty"`
	TailscaleAPIKeyEnv  string `json:"tailscale_api_key_env,omitempty"`
}

// FleetTopology is the serialized manifest the dashboard polls.
type FleetTopology struct {
	Workspace   string          `json:"workspace"`
	GeneratedAt time.Time       `json:"generated_at"`
	Providers   ProviderSummary `json:"providers"`
	Services    []Target        `json:"services"`
}

// BuildTopology derives the polling targets from the workspace config and the
// currently observed Tailscale devices (used to resolve DNS names to live
// hostnames). It is deterministic except for GeneratedAt, which the caller
// supplies so hashing/round-trips stay stable.
func BuildTopology(workspaceName string, cfg *config.Config, devices []tailscale.Device, providers ProviderSummary, now time.Time) FleetTopology {
	topo := FleetTopology{
		Workspace:   workspaceName,
		GeneratedAt: now.UTC(),
		Providers:   providers,
		Services:    []Target{},
	}
	for _, agent := range cfg.Agents {
		if agent.Lifecycle == "absent" {
			continue
		}
		target := Target{
			ID:                agent.ID,
			Kind:              "agent",
			FlyApp:            agent.FlyApp,
			ProviderRef:       agent.Runtime,
			TailscaleHostname: agent.TailscaleHostname,
			URL:               deps.AgentDashboardURL(agent, devices),
			Model:             agent.Model.Default,
			Vault:             agent.DefaultVault.Name,
		}
		if agent.APIServer.Enabled {
			target.HealthURL = deps.AgentAPIBaseURL(agent, devices) + "/health"
		}
		topo.Services = append(topo.Services, target)
	}
	if cfg.OpenWebUI.Enabled && cfg.OpenWebUI.Lifecycle != "absent" {
		topo.Services = append(topo.Services, Target{
			ID:                cfg.OpenWebUI.ID,
			Kind:              "openwebui",
			FlyApp:            cfg.OpenWebUI.FlyApp,
			ProviderRef:       cfg.OpenWebUI.Runtime,
			TailscaleHostname: cfg.OpenWebUI.TailscaleHostname,
			URL:               deps.OpenWebUIURL(cfg.OpenWebUI, devices),
			HealthURL:         deps.OpenWebUIHealthURL(cfg.OpenWebUI, devices),
		})
	}
	return topo
}

// JSON renders the manifest with stable, indented output.
func (t FleetTopology) JSON() ([]byte, error) {
	return json.MarshalIndent(t, "", "  ")
}

// ParseTopology decodes a fleet.json manifest.
func ParseTopology(data []byte) (FleetTopology, error) {
	var topo FleetTopology
	if err := json.Unmarshal(data, &topo); err != nil {
		return FleetTopology{}, fmt.Errorf("parse fleet topology: %w", err)
	}
	return topo, nil
}
