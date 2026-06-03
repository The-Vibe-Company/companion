package state

import (
	"context"
	"path/filepath"
	"testing"
)

func TestImportResourceIsIdempotentByDesiredAddress(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	first := Resource{Address: "fly_app.agent.companion-test", Class: "managed", ProviderRef: "fly.default", ExternalID: "old", ObservedJSON: "{}"}
	second := Resource{Address: "fly_app.agent.companion-test", Class: "managed", ProviderRef: "fly.default", ExternalID: "new", ObservedJSON: `{"region":"cdg"}`}
	if err := store.ImportResource(ctx, first); err != nil {
		t.Fatalf("import first: %v", err)
	}
	if err := store.ImportResource(ctx, second); err != nil {
		t.Fatalf("import second: %v", err)
	}
	resources, err := store.ListResources(ctx)
	if err != nil {
		t.Fatalf("list resources: %v", err)
	}
	if len(resources) != 1 {
		t.Fatalf("expected one resource, got %#v", resources)
	}
	if resources[0].ExternalID != "new" {
		t.Fatalf("expected updated external id, got %q", resources[0].ExternalID)
	}
	if resources[0].ObservedJSON != `{"region":"cdg"}` {
		t.Fatalf("expected updated attrs, got %q", resources[0].ObservedJSON)
	}
}
