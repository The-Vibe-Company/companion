package importer

import "testing"

func TestParseAddress(t *testing.T) {
	address, err := ParseAddress("fly_app.agent.example-peer")
	if err != nil {
		t.Fatalf("parse address: %v", err)
	}
	if address.Type != "fly_app" || address.Group != "agent" || address.Name != "example-peer" {
		t.Fatalf("unexpected address: %#v", address)
	}
}

func TestParseSingletonAddress(t *testing.T) {
	address, err := ParseAddress("openwebui_config.main")
	if err != nil {
		t.Fatalf("parse address: %v", err)
	}
	if address.Type != "openwebui_config" || address.Group != "" || address.Name != "main" {
		t.Fatalf("unexpected address: %#v", address)
	}
}

func TestParseAddressRejectsInvalidShape(t *testing.T) {
	for _, raw := range []string{"fly_app", "Fly_App.agent.example-peer", "fly_app.", "fly_app.agent."} {
		if _, err := ParseAddress(raw); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
}

func TestParseAttrs(t *testing.T) {
	attrs, err := ParseAttrs([]string{"region=cdg", "size=10"})
	if err != nil {
		t.Fatalf("parse attrs: %v", err)
	}
	if attrs["region"] != "cdg" || attrs["size"] != "10" {
		t.Fatalf("unexpected attrs: %#v", attrs)
	}
}
