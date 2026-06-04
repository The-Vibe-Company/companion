package state

import (
	"context"
	"database/sql"
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
	first := Resource{Address: "fly_app.agent.example-peer", Class: "managed", ProviderRef: "fly.default", ExternalID: "old", ObservedJSON: "{}"}
	second := Resource{Address: "fly_app.agent.example-peer", Class: "managed", ProviderRef: "fly.default", ExternalID: "new", ObservedJSON: `{"region":"cdg"}`}
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

func TestOpenReplacesLegacyResourceSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, attrs_json TEXT NOT NULL)`); err != nil {
		t.Fatalf("create legacy resources table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO resources(id, attrs_json) VALUES ('legacy', '{}')`); err != nil {
		t.Fatalf("insert legacy resource: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close raw sqlite: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("open migrated state: %v", err)
	}
	defer store.Close()

	resources, err := store.ListResources(context.Background())
	if err != nil {
		t.Fatalf("list migrated resources: %v", err)
	}
	if len(resources) != 0 {
		t.Fatalf("legacy resources should be dropped during schema replacement, got %#v", resources)
	}
	if err := store.UpsertResource(context.Background(), Resource{
		Address:      "fly_app.agent.sample",
		Class:        "managed",
		ProviderRef:  "fly.default",
		ExternalID:   "co-sample",
		ObservedJSON: "{}",
	}); err != nil {
		t.Fatalf("upsert after migration: %v", err)
	}
	resource, ok, err := store.GetResource(context.Background(), "fly_app.agent.sample")
	if err != nil {
		t.Fatalf("get migrated resource: %v", err)
	}
	if !ok || resource.ExternalID != "co-sample" {
		t.Fatalf("state schema did not accept new resource contract: ok=%v resource=%#v", ok, resource)
	}
}
