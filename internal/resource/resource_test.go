package resource

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/provider"
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
		"fly_app.agent.sample":           ClassManaged,
		"fly_volume.agent_data.sample":   ClassManaged,
		"fly_secrets.agent.sample":       ClassManaged,
		"fly_config.agent.sample":        ClassManaged,
		"rollout.agent.sample":           ClassAction,
		"tailscale_device.agent.sample":  ClassObserved,
		"granite_vault.default.sample":   ClassObserved,
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
	selected := graph.Select([]string{"rollout.agent.sample"}, nil)
	got := addresses(selected.Resources)
	want := []string{
		"fly_app.agent.sample",
		"fly_volume.agent_data.sample",
		"fly_secrets.agent.sample",
		"fly_config.agent.sample",
		"rollout.agent.sample",
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
	flyProvider := fly.New(&execx.FakeRunner{})
	plan, err := BuildPlan(context.Background(), ws, store, provider.Static(flyProvider, tailscale.New(&execx.FakeRunner{Responses: map[string]execx.Result{
		"tailscale status --json": {Stdout: `{"Peer":{}}`},
	}}), flyProvider), Options{
		Root:           ws.Root,
		DestroyTargets: []string{"fly_volume.agent_data.sample"},
	})
	if err != nil {
		t.Fatalf("build plan: %v", err)
	}
	for _, change := range plan.Changes {
		if change.Address == "fly_volume.agent_data.sample" {
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
		ExternalID:   "example-companion-old",
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
	if !ok || resource.ExternalID != "example-companion-old" {
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
			ID:                strPtr("sample"),
			FlyApp:            strPtr("example-companion-sample"),
			TailscaleHostname: strPtr("sample"),
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

func TestCompileDashboardResources(t *testing.T) {
	ws := dashboardWorkspace(t, "sample")
	graph, err := Compile(ws, ws.Root)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	byAddress := graph.ByAddress()
	wants := map[string]string{
		"dashboard_config.main":      ClassDerived,
		"fly_app.dashboard.main":     ClassManaged,
		"fly_secrets.dashboard.main": ClassManaged,
		"rollout.dashboard.main":     ClassAction,
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
	// The dashboard is stateless: it must not declare a volume.
	if _, ok := byAddress["fly_volume.dashboard.main"]; ok {
		t.Fatalf("dashboard must be stateless (no fly_volume)")
	}
	rollout := byAddress["rollout.dashboard.main"]
	for _, dep := range []string{"fly_app.dashboard.main", "fly_secrets.dashboard.main", "dashboard_config.main"} {
		if !containsString(rollout.DependsOn, dep) {
			t.Fatalf("rollout.dashboard.main missing dependency %s (deps=%v)", dep, rollout.DependsOn)
		}
	}
}

func TestDashboardTopologyHashGating(t *testing.T) {
	one := dashboardWorkspace(t, "research")
	two := dashboardWorkspace(t, "research", "writer")

	h1, _, err := hashDashboardTopology(one, nil)
	if err != nil {
		t.Fatalf("hash one: %v", err)
	}
	h2, _, err := hashDashboardTopology(two, nil)
	if err != nil {
		t.Fatalf("hash two: %v", err)
	}
	if h1 == h2 {
		t.Fatalf("topology hash should change when an agent is added (apply must redeploy the dashboard)")
	}
	// Deterministic and timestamp-independent: re-hashing the same fleet matches.
	h1again, _, err := hashDashboardTopology(one, nil)
	if err != nil {
		t.Fatalf("hash one again: %v", err)
	}
	if h1 != h1again {
		t.Fatalf("topology hash must be deterministic and exclude the generated timestamp")
	}
}

func dashboardWorkspace(t *testing.T, agentIDs ...string) *workspace.Workspace {
	t.Helper()
	root := t.TempDir()
	agents := make([]config.RawAgent, 0, len(agentIDs))
	for _, id := range agentIDs {
		agents = append(agents, config.RawAgent{ID: strPtr(id), FlyApp: strPtr("co-" + id), TailscaleHostname: strPtr(id)})
	}
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
		Dashboard: config.RawDashboard{Enabled: boolPtr(true)},
		Agents:    agents,
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

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
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
