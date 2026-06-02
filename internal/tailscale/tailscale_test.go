package tailscale

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/execx"
)

func TestDeleteDeviceUsesTailscaleAPI(t *testing.T) {
	var sawDelete bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		if r.URL.Path != "/api/v2/device/device-id" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "api-key" || pass != "" {
			t.Fatalf("unexpected auth")
		}
		sawDelete = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	if err := DeleteDevice(context.Background(), server.URL, "api-key", "device-id"); err != nil {
		t.Fatalf("delete device: %v", err)
	}
	if !sawDelete {
		t.Fatalf("expected delete request")
	}
}

func TestDevicesPreferPayloadIDOverPeerMapKey(t *testing.T) {
	provider := New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{
			"nodekey:abc":{"ID":"nShortID","HostName":"companion-test","DNSName":"companion-test.tail.ts.net."}
		}}`},
	}})
	devices, err := provider.Devices(context.Background())
	if err != nil {
		t.Fatalf("devices: %v", err)
	}
	if len(devices) != 1 || devices[0].ID != "nShortID" {
		t.Fatalf("unexpected devices: %#v", devices)
	}
}
