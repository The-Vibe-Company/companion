package tailscale_test

import (
	"context"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/providertest"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestAPIProviderListsAndDeletesDevices(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.SetTailscaleDevices([]tailscale.Device{{
		ID:       "dev-1",
		HostName: "victor",
		DNSName:  "victor.tail.ts.net.",
		Online:   true,
		IP:       "100.64.0.1",
	}})

	provider := tailscale.NewAPI(server.TailscaleBaseURL(), "ts-api-key", "tail.ts.net")
	devices, err := provider.Devices(context.Background())
	if err != nil {
		t.Fatalf("devices: %v", err)
	}
	if len(devices) != 1 || devices[0].HostName != "victor" || devices[0].IP != "100.64.0.1" {
		t.Fatalf("unexpected devices: %#v", devices)
	}
	if len(server.TailscaleAuthHeaders) == 0 || !strings.HasPrefix(server.TailscaleAuthHeaders[0], "Basic ") {
		t.Fatalf("expected basic auth header, got %#v", server.TailscaleAuthHeaders)
	}
	if err := provider.DeleteDevice(context.Background(), "dev-1"); err != nil {
		t.Fatalf("delete device: %v", err)
	}
	devices, err = provider.Devices(context.Background())
	if err != nil {
		t.Fatalf("devices after delete: %v", err)
	}
	if len(devices) != 0 {
		t.Fatalf("expected empty devices, got %#v", devices)
	}
}
