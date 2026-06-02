package tailscalectl

import (
	"sort"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

type CleanupCandidate struct {
	AgentID  string
	DeviceID string
	HostName string
	DNSName  string
	Reason   string
}

type CleanupPlan struct {
	Keep       map[string]tailscale.Device
	Candidates []CleanupCandidate
}

func PlanCleanup(agents []config.Agent, devices []tailscale.Device) CleanupPlan {
	plan := CleanupPlan{Keep: map[string]tailscale.Device{}}
	for _, agent := range agents {
		matches := tailscale.FindByHostname(devices, agent.TailscaleHostname)
		if len(matches) <= 1 {
			if len(matches) == 1 {
				plan.Keep[agent.ID] = matches[0]
			}
			continue
		}
		keep := selectDeviceToKeep(agent.TailscaleHostname, matches)
		plan.Keep[agent.ID] = keep
		for _, device := range matches {
			if device.ID == keep.ID || device.Online {
				continue
			}
			plan.Candidates = append(plan.Candidates, CleanupCandidate{
				AgentID:  agent.ID,
				DeviceID: device.ID,
				HostName: device.HostName,
				DNSName:  strings.TrimSuffix(device.DNSName, "."),
				Reason:   "offline duplicate",
			})
		}
	}
	return plan
}

func selectDeviceToKeep(hostname string, devices []tailscale.Device) tailscale.Device {
	sorted := append([]tailscale.Device(nil), devices...)
	sort.SliceStable(sorted, func(i, j int) bool {
		left := sorted[i]
		right := sorted[j]
		if left.Online != right.Online {
			return left.Online
		}
		leftCanonical := shortDNS(left.DNSName) == hostname
		rightCanonical := shortDNS(right.DNSName) == hostname
		if leftCanonical != rightCanonical {
			return leftCanonical
		}
		if !left.LastSeen.Equal(right.LastSeen) {
			return left.LastSeen.After(right.LastSeen)
		}
		if !left.Created.Equal(right.Created) {
			return left.Created.After(right.Created)
		}
		return left.ID < right.ID
	})
	return sorted[0]
}

func shortDNS(value string) string {
	value = strings.TrimSuffix(value, ".")
	return strings.Split(value, ".")[0]
}
