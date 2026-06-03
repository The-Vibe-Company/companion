package tailscalectl

import (
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

func TestPlanCleanupDeletesOnlyOfflineDuplicates(t *testing.T) {
	plan := PlanCleanup([]config.Agent{{
		ID:                "example-peer",
		TailscaleHostname: "example-peer",
	}}, []tailscale.Device{
		{ID: "offline-canonical", HostName: "example-peer", DNSName: "example-peer.tail.ts.net.", Online: false},
		{ID: "active-suffix", HostName: "example-peer", DNSName: "example-peer-2.tail.ts.net.", Online: true},
		{ID: "other", HostName: "other", DNSName: "other.tail.ts.net.", Online: false},
	})
	if plan.Keep["example-peer"].ID != "active-suffix" {
		t.Fatalf("expected active device to be kept, got %#v", plan.Keep["example-peer"])
	}
	if len(plan.Candidates) != 1 {
		t.Fatalf("expected one candidate, got %#v", plan.Candidates)
	}
	if plan.Candidates[0].DeviceID != "offline-canonical" {
		t.Fatalf("unexpected candidate: %#v", plan.Candidates[0])
	}
}
