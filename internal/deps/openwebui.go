package deps

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func OpenWebUIConnections(ctx context.Context, cfg *config.Config, tsProvider tailscale.Provider) []config.OpenWebUIConnection {
	devices, _ := tsProvider.Devices(ctx)
	return OpenWebUIConnectionsForDevices(cfg, devices)
}

func OpenWebUIConnectionsForDevices(cfg *config.Config, devices []tailscale.Device) []config.OpenWebUIConnection {
	connections := []config.OpenWebUIConnection{}
	for _, agent := range cfg.Agents {
		api := agent.APIServer
		if !api.Enabled || !api.OpenWebUIEnabled {
			continue
		}
		connections = append(connections, config.OpenWebUIConnection{
			AgentID:       agent.ID,
			ModelName:     api.ModelName,
			URL:           AgentAPIBaseURL(agent, devices) + "/v1",
			KeySecretName: api.KeySecretName,
		})
	}
	return connections
}

func AgentAPIBaseURL(agent config.Agent, devices []tailscale.Device) string {
	api := agent.APIServer
	if api.OpenWebUIURL != "" {
		parsed, err := url.Parse(api.OpenWebUIURL)
		if err == nil {
			parsed.Path = strings.TrimSuffix(parsed.Path, "/v1")
			return strings.TrimRight(parsed.String(), "/")
		}
	}
	host := api.OpenWebUIHost
	if host == "" || host == agent.TailscaleHostname {
		if resolved := TailscaleDNSName(devices, agent.TailscaleHostname); resolved != "" {
			host = resolved
		}
	}
	if host == "" {
		host = agent.TailscaleHostname
	}
	return fmt.Sprintf("http://%s:%d", host, api.Port)
}

func TailscaleDNSName(devices []tailscale.Device, hostname string) string {
	matches := tailscale.FindByHostname(devices, hostname)
	if len(matches) == 0 {
		return ""
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Online != matches[j].Online {
			return matches[i].Online
		}
		return matches[i].DNSName < matches[j].DNSName
	})
	for _, device := range matches {
		if device.Online && device.DNSName != "" {
			return strings.TrimSuffix(device.DNSName, ".")
		}
	}
	for _, device := range matches {
		if shortDNS(device.DNSName) == hostname {
			return strings.TrimSuffix(device.DNSName, ".")
		}
	}
	return strings.TrimSuffix(matches[0].DNSName, ".")
}

func shortDNS(value string) string {
	value = strings.TrimSuffix(value, ".")
	return strings.Split(value, ".")[0]
}
