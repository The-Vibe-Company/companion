package importer

import "testing"

func TestParseAddress(t *testing.T) {
	address, err := ParseAddress("fly_app.companion-test")
	if err != nil {
		t.Fatalf("parse address: %v", err)
	}
	if address.Provider != "fly" || address.Kind != "app" || address.DesiredID != "companion-test" {
		t.Fatalf("unexpected address: %#v", address)
	}
}

func TestParseAddressRejectsInvalidShape(t *testing.T) {
	for _, raw := range []string{"fly_app", "fly.companion-test", "Fly_App.companion-test", "fly_app."} {
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
