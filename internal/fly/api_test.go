package fly_test

import (
	"context"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/providertest"
)

func TestAPIProviderCreatesAppVolumeSecretsAndUsesAuth(t *testing.T) {
	server := providertest.New()
	defer server.Close()

	provider := fly.NewAPI(server.FlyBaseURL(), "fly-token", "example-org")
	ctx := context.Background()
	if exists, err := provider.AppExists(ctx, "example-companion-sample"); err != nil || exists {
		t.Fatalf("expected missing app, exists=%v err=%v", exists, err)
	}
	if err := provider.CreateApp(ctx, "example-companion-sample"); err != nil {
		t.Fatalf("create app: %v", err)
	}
	if exists, err := provider.AppExists(ctx, "example-companion-sample"); err != nil || !exists {
		t.Fatalf("expected app, exists=%v err=%v", exists, err)
	}
	if _, err := provider.EnsureVolume(ctx, "example-companion-sample", "data", "cdg", 3); err != nil {
		t.Fatalf("ensure volume: %v", err)
	}
	if err := provider.SetSecrets(ctx, "example-companion-sample", map[string]string{"API_SERVER_KEY": "secret-value"}); err != nil {
		t.Fatalf("set secrets: %v", err)
	}
	names, err := provider.SecretNames(ctx, "example-companion-sample")
	if err != nil {
		t.Fatalf("secret names: %v", err)
	}
	if !names["API_SERVER_KEY"] {
		t.Fatalf("missing secret name: %#v", names)
	}
	if len(server.FlyAuthHeaders) == 0 || server.FlyAuthHeaders[0] != "Bearer fly-token" {
		t.Fatalf("expected bearer auth, got %#v", server.FlyAuthHeaders)
	}
}

func TestAPIProviderExtendsSelectedAttachedVolume(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.AddVolume("example-companion-sample", fly.Volume{ID: "vol_old", Name: "data", SizeGB: 1, Region: "cdg"})
	server.AddVolume("example-companion-sample", fly.Volume{ID: "vol_attached", Name: "data", SizeGB: 1, Region: "cdg", AttachedMachineID: "machine"})

	provider := fly.NewAPI(server.FlyBaseURL(), "fly-token", "example-org")
	if _, err := provider.EnsureVolume(context.Background(), "example-companion-sample", "data", "cdg", 5); err != nil {
		t.Fatalf("ensure volume: %v", err)
	}
	volumes, err := provider.ListVolumes(context.Background(), "example-companion-sample")
	if err != nil {
		t.Fatalf("list volumes: %v", err)
	}
	selected, _, ok := fly.SelectVolume(volumes, "data")
	if !ok {
		t.Fatalf("expected volume")
	}
	if selected.ID != "vol_attached" || selected.SizeGB != 5 {
		t.Fatalf("expected attached volume to be extended, got %#v", selected)
	}
}
