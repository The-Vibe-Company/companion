package tailscale

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/The-Vibe-Company/companion/internal/execx"
)

type Provider struct {
	Runner execx.Runner
}

type Device struct {
	ID       string
	HostName string
	DNSName  string
	Online   bool
	IP       string
	Created  time.Time
	LastSeen time.Time
}

type statusJSON struct {
	Self map[string]any            `json:"Self"`
	Peer map[string]map[string]any `json:"Peer"`
}

func New(runner execx.Runner) Provider {
	return Provider{Runner: runner}
}

func (p Provider) Devices(ctx context.Context) ([]Device, error) {
	result, err := p.Runner.Run(ctx, []string{"tailscale", "status", "--json"})
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) == "" {
		return nil, nil
	}
	var payload statusJSON
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		return nil, err
	}
	var devices []Device
	for id, peer := range payload.Peer {
		devices = append(devices, mapDevice(id, peer))
	}
	if len(payload.Self) > 0 {
		devices = append(devices, mapDevice("self", payload.Self))
	}
	return devices, nil
}

func FindByHostname(devices []Device, hostname string) []Device {
	var matches []Device
	for _, device := range devices {
		shortDNS := strings.TrimSuffix(device.DNSName, ".")
		shortDNS = strings.Split(shortDNS, ".")[0]
		if device.HostName == hostname || shortDNS == hostname {
			matches = append(matches, device)
		}
	}
	return matches
}

func mapDevice(id string, raw map[string]any) Device {
	device := Device{ID: id}
	if value, ok := raw["ID"].(string); ok && value != "" {
		device.ID = value
	}
	if value, ok := raw["HostName"].(string); ok {
		device.HostName = value
	}
	if value, ok := raw["DNSName"].(string); ok {
		device.DNSName = value
	}
	if value, ok := raw["Online"].(bool); ok {
		device.Online = value
	}
	if ips, ok := raw["TailscaleIPs"].([]any); ok && len(ips) > 0 {
		if value, ok := ips[0].(string); ok {
			device.IP = value
		}
	}
	if value, ok := raw["Created"].(string); ok {
		device.Created = parseTime(value)
	}
	if value, ok := raw["LastSeen"].(string); ok {
		device.LastSeen = parseTime(value)
	}
	return device
}

func DeleteDevice(ctx context.Context, baseURL, apiKey, deviceID string) error {
	if baseURL == "" {
		baseURL = "https://api.tailscale.com"
	}
	if strings.TrimSpace(apiKey) == "" {
		return fmt.Errorf("TAILSCALE_API_KEY is required")
	}
	if strings.TrimSpace(deviceID) == "" {
		return fmt.Errorf("device id is required")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, strings.TrimRight(baseURL, "/")+"/api/v2/device/"+deviceID, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(apiKey, "")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("tailscale delete device %s failed: HTTP %d", deviceID, resp.StatusCode)
	}
	return nil
}

func parseTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
