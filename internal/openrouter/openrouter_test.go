package openrouter

import (
	"context"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/providertest"
)

func TestClientParsesModelsAndUsesBearerAuth(t *testing.T) {
	server := providertest.New()
	defer server.Close()
	server.SetOpenRouterModels([]string{"google/gemini-3.5-flash"})

	client := New(server.OpenRouterBaseURL(), "or-token")
	ok, err := client.HasModel(context.Background(), "google/gemini-3.5-flash")
	if err != nil {
		t.Fatalf("has model: %v", err)
	}
	if !ok {
		t.Fatalf("expected model to exist")
	}
	ok, err = client.HasModel(context.Background(), "missing/model")
	if err != nil {
		t.Fatalf("has missing model: %v", err)
	}
	if ok {
		t.Fatalf("expected missing model")
	}
	if len(server.OpenRouterAuth) == 0 || server.OpenRouterAuth[0] != "Bearer or-token" {
		t.Fatalf("expected bearer auth, got %#v", server.OpenRouterAuth)
	}
}
