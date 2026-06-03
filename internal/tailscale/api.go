package tailscale

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const DefaultAPIBaseURL = "https://api.tailscale.com"

type APIProvider struct {
	BaseURL string
	APIKey  string
	Tailnet string
	Client  *http.Client
}

func NewAPI(baseURL, apiKey, tailnet string) APIProvider {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultAPIBaseURL
	}
	return APIProvider{BaseURL: strings.TrimRight(baseURL, "/"), APIKey: apiKey, Tailnet: tailnet, Client: http.DefaultClient}
}

func (p APIProvider) Devices(ctx context.Context) ([]Device, error) {
	if strings.TrimSpace(p.Tailnet) == "" {
		return nil, fmt.Errorf("tailscale tailnet is required")
	}
	resp, err := p.do(ctx, http.MethodGet, "/api/v2/tailnet/"+url.PathEscape(p.Tailnet)+"/devices")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := requireAPI2xx(resp, "tailscale devices list"); err != nil {
		return nil, err
	}
	var payload struct {
		Devices []apiDevice `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	devices := make([]Device, 0, len(payload.Devices))
	for _, device := range payload.Devices {
		devices = append(devices, device.toDevice())
	}
	return devices, nil
}

func (p APIProvider) DeleteDevice(ctx context.Context, deviceID string) error {
	if strings.TrimSpace(deviceID) == "" {
		return fmt.Errorf("device id is required")
	}
	resp, err := p.do(ctx, http.MethodDelete, "/api/v2/device/"+url.PathEscape(deviceID))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return requireAPI2xx(resp, "tailscale device delete")
}

func (p APIProvider) do(ctx context.Context, method, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, p.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	if p.APIKey != "" {
		req.SetBasicAuth(p.APIKey, "")
	}
	return p.client().Do(req)
}

func (p APIProvider) client() *http.Client {
	if p.Client != nil {
		return p.Client
	}
	return http.DefaultClient
}

type apiDevice struct {
	ID        string   `json:"id"`
	Hostname  string   `json:"hostname"`
	Name      string   `json:"name"`
	DNSName   string   `json:"dns_name"`
	Addresses []string `json:"addresses"`
	Online    bool     `json:"online"`
	Created   string   `json:"created"`
	LastSeen  string   `json:"lastSeen"`
}

func (d apiDevice) toDevice() Device {
	dnsName := firstAPIValue(d.DNSName, d.Name)
	ip := ""
	if len(d.Addresses) > 0 {
		ip = d.Addresses[0]
	}
	return Device{
		ID:       d.ID,
		HostName: d.Hostname,
		DNSName:  dnsName,
		Online:   d.Online,
		IP:       ip,
		Created:  parseTime(d.Created),
		LastSeen: parseTime(d.LastSeen),
	}
}

func requireAPI2xx(resp *http.Response, operation string) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	message := strings.TrimSpace(string(data))
	if message == "" {
		message = resp.Status
	}
	return fmt.Errorf("%s failed: HTTP %d %s", operation, resp.StatusCode, message)
}

func firstAPIValue(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
