package resource

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

func TestCompileAgentAndOpenWebUIResources(t *testing.T) {
	ws := testWorkspace(t)
	graph, err := Compile(ws, ws.Root)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	byAddress := graph.ByAddress()
	wants := map[string]string{
		"fly_app.agent.victor":           ClassManaged,
		"fly_volume.agent_data.victor":   ClassManaged,
		"fly_secrets.agent.victor":       ClassManaged,
		"fly_config.agent.victor":        ClassManaged,
		"rollout.agent.victor":           ClassAction,
		"tailscale_device.agent.victor":  ClassObserved,
		"granite_vault.default.victor":   ClassObserved,
		"openwebui_config.main":          ClassDerived,
		"fly_app.openwebui.main":         ClassManaged,
		"fly_volume.openwebui_data.main": ClassManaged,
		"fly_secrets.openwebui.main":     ClassManaged,
		"rollout.openwebui.main":         ClassAction,
	}
	for address, class := range wants {
		resource, ok := byAddress[address]
		if !ok {
			t.Fatalf("missing resource %s", address)
		}
		if resource.Class != class {
			t.Fatalf("resource %s class: got %s want %s", address, resource.Class, class)
		}
	}
}

func TestTargetedSelectIncludesDependenciesInStableOrder(t *testing.T) {
	ws := testWorkspace(t)
	graph, err := Compile(ws, ws.Root)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	selected := graph.Select([]string{"rollout.agent.victor"}, nil)
	got := addresses(selected.Resources)
	want := []string{
		"fly_app.agent.victor",
		"fly_volume.agent_data.victor",
		"fly_secrets.agent.victor",
		"fly_config.agent.victor",
		"rollout.agent.victor",
	}
	if len(got) != len(want) {
		t.Fatalf("selected addresses: got %#v want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("selected addresses: got %#v want %#v", got, want)
		}
	}
}

func TestBuildPlanBlocksProtectedVolumeDestroy(t *testing.T) {
	ws := testWorkspace(t)
	store := openTestState(t)
	plan, err := BuildPlan(context.Background(), ws, store, fly.New(&execx.FakeRunner{}), tailscale.New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{}}`},
	}}), Options{
		Root:           ws.Root,
		DestroyTargets: []string{"fly_volume.agent_data.victor"},
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	for _, change := range plan.Changes {
		if change.Address == "fly_volume.agent_data.victor" {
			if change.Kind != "!" || change.Action != "blocked" {
				t.Fatalf("expected protected block, got %#v", change)
			}
			return
		}
	}
	t.Fatalf("missing volume destroy change: %#v", plan.Changes)
}

func TestMarkOrphanUpdatesObservedStateWithoutDeleting(t *testing.T) {
	store := openTestState(t)
	ctx := context.Background()
	if err := store.ImportResource(ctx, state.Resource{
		Address:      "fly_app.agent.old",
		Class:        ClassManaged,
		ProviderRef:  "fly.default",
		ExternalID:   "tvc-companion-old",
		Status:       "ready",
		ObservedJSON: "{}",
	}); err != nil {
		t.Fatalf("import resource: %v", err)
	}
	if err := markOrphan(ctx, store, Change{Address: "fly_app.agent.old"}); err != nil {
		t.Fatalf("mark orphan: %v", err)
	}
	resource, ok, err := store.GetResource(ctx, "fly_app.agent.old")
	if err != nil {
		t.Fatalf("get resource: %v", err)
	}
	if !ok || resource.ExternalID != "tvc-companion-old" {
		t.Fatalf("expected resource to remain in state, got %#v", resource)
	}
	if resource.Status != "orphan" {
		t.Fatalf("expected orphan status, got %#v", resource)
	}
}

func addresses(resources []Resource) []string {
	out := make([]string, 0, len(resources))
	for _, resource := range resources {
		out = append(out, resource.Address)
	}
	return out
}

func testWorkspace(t *testing.T) *workspace.Workspace {
	t.Helper()
	root := t.TempDir()
	cfg, err := config.Normalize(config.RawConfig{
		Defaults: config.RawDefaults{
			Model: config.RawModel{
				Enabled:          boolPtr(true),
				Default:          strPtr("google/gemini-3.5-flash"),
				APIKeySecretName: strPtr("OPENROUTER_API_KEY"),
				APIKeyEnv:        strPtr("OPENROUTER_API_KEY"),
			},
			APIServer: config.RawAPIServer{Enabled: boolPtr(true), OpenWebUIEnabled: boolPtr(true)},
		},
		OpenWebUI: config.RawOpenWebUI{Enabled: boolPtr(true)},
		Agents: []config.RawAgent{{
			ID:                strPtr("victor"),
			FlyApp:            strPtr("tvc-companion-victor"),
			TailscaleHostname: strPtr("victor"),
		}},
	})
	if err != nil {
		t.Fatalf("normalize config: %v", err)
	}
	return &workspace.Workspace{
		Root:      root,
		Name:      "test",
		StatePath: filepath.Join(root, ".companion", "state.sqlite"),
		Config:    cfg,
	}
}

func openTestState(t *testing.T) *state.Store {
	t.Helper()
	store, err := state.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func strPtr(value string) *string { return &value }
func boolPtr(value bool) *bool    { return &value }
