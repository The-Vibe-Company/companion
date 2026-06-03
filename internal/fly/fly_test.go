package fly

import (
	"context"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/execx"
)

func TestSelectVolumePrefersAttached(t *testing.T) {
	selected, matches, ok := SelectVolume([]Volume{
		{ID: "vol-old", Name: "data", CreatedAt: "2026-01-01T00:00:00Z"},
		{ID: "vol-attached", Name: "data", AttachedMachineID: "machine", CreatedAt: "2026-02-01T00:00:00Z"},
	}, "data")
	if !ok {
		t.Fatalf("expected match")
	}
	if selected.ID != "vol-attached" {
		t.Fatalf("expected attached volume, got %s", selected.ID)
	}
	if len(matches) != 2 {
		t.Fatalf("expected duplicate matches")
	}
}

func TestRedactedSecretsCommand(t *testing.T) {
	cmd := RedactedSecretsCommand("app", map[string]string{"SECRET": "actual"})
	if cmd != "fly secrets set -a app SECRET=..." {
		t.Fatalf("unexpected redacted command: %s", cmd)
	}
}

func TestSecretNames(t *testing.T) {
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly secrets list -a app --json": {Stdout: `[{"name":"TS_AUTHKEY"},{"name":"API_SERVER_KEY"}]`},
	}}
	provider := New(runner)
	names, err := provider.SecretNames(context.Background(), "app")
	if err != nil {
		t.Fatalf("secret names: %v", err)
	}
	if !names["TS_AUTHKEY"] || !names["API_SERVER_KEY"] {
		t.Fatalf("unexpected names: %#v", names)
	}
}

func TestCreateAppUsesConfiguredOrg(t *testing.T) {
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly apps create app --org personal": {},
	}}
	provider := NewWithOrg(runner, "personal")
	if err := provider.CreateApp(context.Background(), "app"); err != nil {
		t.Fatalf("create app: %v", err)
	}
	if len(runner.Calls) != 1 {
		t.Fatalf("expected one call, got %#v", runner.Calls)
	}
}

func TestDeployUsesRemoteBuildAndWaitsForRollout(t *testing.T) {
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly deploy . -a app -c fly.toml --ha=false --remote-only": {},
	}}
	provider := New(runner)
	if err := provider.Deploy(context.Background(), "app", "fly.toml"); err != nil {
		t.Fatalf("deploy: %v", err)
	}
	if len(runner.Calls) != 1 {
		t.Fatalf("expected one call, got %#v", runner.Calls)
	}
}

func TestListMachinesParsesFlyImageRefObject(t *testing.T) {
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly machines list -a app --json": {Stdout: `[{
			"id":"machine",
			"state":"started",
			"image_ref":{"repository":"app","tag":"deployment"},
			"config":{"env":{"OPENAI_API_BASE_URLS":"http://agent:8642/v1"}}
		}]`},
	}}
	provider := New(runner)
	machines, err := provider.ListMachines(context.Background(), "app")
	if err != nil {
		t.Fatalf("list machines: %v", err)
	}
	if len(machines) != 1 || machines[0].Config.Env["OPENAI_API_BASE_URLS"] == "" {
		t.Fatalf("unexpected machines: %#v", machines)
	}
}
