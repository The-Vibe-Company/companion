package console

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/The-Vibe-Company/companion/internal/workspace"
)

// fixedClock returns a deterministic clock for backup-path assertions.
func fixedClock(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

var testStamp = time.Date(2026, 6, 4, 12, 30, 45, 123456789, time.UTC)

// newTestWorkspace lays down a minimal but complete Companion workspace under a
// fresh temp dir and returns its root. It mirrors examples/minimal so files the
// console writes re-load through workspace.Load + Validate.
func newTestWorkspace(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeWS(t, root, "companion.toml", `workspace = "console-test"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
`)
	writeWS(t, root, "providers.toml", `[fly.default]
region = "cdg"
token_env = "FLY_API_TOKEN"

[tailscale.default]
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
`)
	writeWS(t, root, "defaults.toml", `[defaults]
region = "cdg"

[defaults.model]
enabled = true
default = "google/gemini-3.5-flash"
api_key_secret_name = "OPENROUTER_API_KEY"
api_key_env = "OPENROUTER_API_KEY"

[defaults.default_vault]
enabled = true
name = "Default"
mcp_enabled = true
mcp_role = "write"

[defaults.companion_soul]
enabled = true
text = "Fleet rule: persist durable learnings to Granite."
`)
	writeWS(t, root, "webui.toml", `[open_webui]
enabled = false
`)
	return root
}

func writeWS(t *testing.T, root, name, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", name, err)
	}
	if err := os.WriteFile(p, []byte(strings.TrimSpace(content)+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

// writeAgentInput is the create flow the API layer performs: build the file,
// write its soul (if any), write the TOML.
func writeAgentInput(t *testing.T, w *TomlWriter, in AgentInput) {
	t.Helper()
	file, err := w.BuildAgentFile(in)
	if err != nil {
		t.Fatalf("BuildAgentFile(%s): %v", in.ID, err)
	}
	if strings.TrimSpace(in.Soul) != "" {
		if _, err := w.WriteSoul(in.ID, in.Soul); err != nil {
			t.Fatalf("WriteSoul(%s): %v", in.ID, err)
		}
	}
	if _, err := w.WriteAgent(in.ID, file); err != nil {
		t.Fatalf("WriteAgent(%s): %v", in.ID, err)
	}
}

func TestTOMLWriterCreateLoadsAndValidates(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	enabled := true
	writeAgentInput(t, w, AgentInput{
		ID:                   "alpha-agent",
		Model:                "anthropic/claude-3.7-sonnet",
		Region:               "cdg",
		FlyApp:               "alpha-companion-agent",
		TailscaleHostname:    "alpha-agent",
		Soul:                 "You are Alpha. Persist learnings to Granite.",
		CompanionSoulEnabled: &enabled,
		VaultName:            "Alpha Vault",
	})

	// The written file must re-load through the real workspace loader+validator.
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load after create: %v", err)
	}
	if got := len(ws.Config.Agents); got != 1 {
		t.Fatalf("agent count = %d, want 1", got)
	}
	agent := ws.Config.Agents[0]
	if agent.ID != "alpha-agent" {
		t.Errorf("agent id = %q, want alpha-agent", agent.ID)
	}
	if agent.FlyApp != "alpha-companion-agent" {
		t.Errorf("fly_app = %q, want alpha-companion-agent", agent.FlyApp)
	}
	if agent.Model.Default != "anthropic/claude-3.7-sonnet" {
		t.Errorf("model.default = %q, want anthropic/claude-3.7-sonnet", agent.Model.Default)
	}
	if agent.DefaultVault.Name != "Alpha Vault" {
		t.Errorf("default_vault.name = %q, want Alpha Vault", agent.DefaultVault.Name)
	}
	if !agent.CompanionSoul.Enabled {
		t.Errorf("companion_soul.enabled = false, want true")
	}
	if !agent.Identity.Enabled {
		t.Errorf("identity.enabled = false, want true (soul provided)")
	}
	if agent.Identity.Path != "identities/alpha-agent/SOUL.md" {
		t.Errorf("identity.path = %q, want identities/alpha-agent/SOUL.md", agent.Identity.Path)
	}

	// The SOUL.md is on disk for apply to render.
	soul, err := os.ReadFile(w.SoulPath("alpha-agent"))
	if err != nil {
		t.Fatalf("read SOUL.md: %v", err)
	}
	if !strings.Contains(string(soul), "You are Alpha.") {
		t.Errorf("SOUL.md missing expected content: %q", soul)
	}
}

func TestTOMLWriterCompanionSoulDisable(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	// The fleet defaults enable companion_soul; the per-agent knob disables it.
	disabled := false
	writeAgentInput(t, w, AgentInput{ID: "theta-agent", CompanionSoulEnabled: &disabled})

	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load: %v", err)
	}
	if ws.Config.Agents[0].CompanionSoul.Enabled {
		t.Errorf("companion_soul.enabled = true, want false (per-agent disable)")
	}

	// An agent that says nothing inherits the fleet default (enabled).
	writeAgentInput(t, w, AgentInput{ID: "iota-agent"})
	ws2, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load: %v", err)
	}
	for _, a := range ws2.Config.Agents {
		if a.ID == "iota-agent" && !a.CompanionSoul.Enabled {
			t.Errorf("iota-agent companion_soul.enabled = false, want true (inherited default)")
		}
	}
}

func TestTOMLWriterCreateAppliesDefaults(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	// Only id supplied: fly_app/tailscale_hostname/runtime/network/model_provider/
	// lifecycle must fall back to console defaults that mirror examples/minimal.
	writeAgentInput(t, w, AgentInput{ID: "beta-agent"})

	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load: %v", err)
	}
	agent := ws.Config.Agents[0]
	checks := map[string]string{
		"runtime":            agent.Runtime,
		"network":            agent.Network,
		"model_provider":     agent.ModelProvider,
		"lifecycle":          agent.Lifecycle,
		"fly_app":            agent.FlyApp,
		"tailscale_hostname": agent.TailscaleHostname,
	}
	want := map[string]string{
		"runtime":            "fly.default",
		"network":            "tailscale.default",
		"model_provider":     "openrouter.default",
		"lifecycle":          "present",
		"fly_app":            "beta-agent",
		"tailscale_hostname": "beta-agent",
	}
	for k, v := range want {
		if checks[k] != v {
			t.Errorf("%s = %q, want %q", k, checks[k], v)
		}
	}
}

func TestTOMLWriterUpdateBacksUpBeforeOverwrite(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	writeAgentInput(t, w, AgentInput{ID: "gamma-agent", Memory: "2gb"})
	original, err := os.ReadFile(w.AgentPath("gamma-agent"))
	if err != nil {
		t.Fatalf("read original: %v", err)
	}

	// First write created the file: no backup expected.
	file, err := w.BuildAgentFile(AgentInput{ID: "gamma-agent", Memory: "8gb"})
	if err != nil {
		t.Fatalf("BuildAgentFile: %v", err)
	}
	backupDir, err := w.WriteAgent("gamma-agent", file)
	if err != nil {
		t.Fatalf("WriteAgent (overwrite): %v", err)
	}

	// Overwriting an existing file must produce a deterministic backup path.
	wantBackupDir := filepath.Join(root, ".companion", "backups", backupStamp(testStamp))
	if backupDir != wantBackupDir {
		t.Fatalf("backupDir = %q, want %q", backupDir, wantBackupDir)
	}
	backupFile := filepath.Join(backupDir, "agents", "gamma-agent.toml")
	saved, err := os.ReadFile(backupFile)
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if string(saved) != string(original) {
		t.Errorf("backup content mismatch:\n got %q\nwant %q", saved, original)
	}

	// The live file now reflects the update and still loads.
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load after update: %v", err)
	}
	if ws.Config.Agents[0].Memory != "8gb" {
		t.Errorf("memory = %q, want 8gb", ws.Config.Agents[0].Memory)
	}
}

func TestTOMLWriterDeleteSetsAbsentKeepsFile(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	writeAgentInput(t, w, AgentInput{ID: "delta-agent"})

	backupDir, err := w.SetLifecycleAbsent("delta-agent")
	if err != nil {
		t.Fatalf("SetLifecycleAbsent: %v", err)
	}
	if backupDir == "" {
		t.Fatalf("expected a backup when rewriting an existing file")
	}

	// The file must still exist (delete is soft: lifecycle=absent).
	target := w.AgentPath("delta-agent")
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("agent file must remain after delete: %v", err)
	}

	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load after delete: %v", err)
	}
	if got := ws.Config.Agents[0].Lifecycle; got != "absent" {
		t.Errorf("lifecycle = %q, want absent", got)
	}

	// Sanity: the raw TOML carries lifecycle = "absent".
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read agent: %v", err)
	}
	var file agentTOMLFile
	if err := toml.Unmarshal(data, &file); err != nil {
		t.Fatalf("unmarshal agent: %v", err)
	}
	if file.Agent.Lifecycle == nil || *file.Agent.Lifecycle != "absent" {
		t.Errorf("[agent].lifecycle in file = %v, want absent", file.Agent.Lifecycle)
	}
}

func TestTOMLWriterRejectsInvalidID(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	cases := []struct {
		name string
		id   string
	}{
		{"empty", ""},
		{"path traversal", "../escape"},
		{"slash", "team/agent"},
		{"dot dot", "a..b"},
		{"uppercase", "BadAgent"},
		{"leading hyphen", "-bad"},
		{"underscore", "bad_agent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := w.BuildAgentFile(AgentInput{ID: tc.id}); err == nil {
				t.Fatalf("BuildAgentFile(%q) = nil error, want rejection", tc.id)
			}
		})
	}

	// No agent file should have been created for the traversal attempt.
	if _, err := os.Stat(filepath.Join(root, "agents")); err == nil {
		entries, _ := os.ReadDir(filepath.Join(root, "agents"))
		if len(entries) != 0 {
			t.Errorf("invalid ids must not write files, found %d entries", len(entries))
		}
	}
}

func TestTOMLWriterFixedClockDeterministicBackupPath(t *testing.T) {
	root := newTestWorkspace(t)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	w := NewTomlWriter(root, fixedClock(stamp))

	writeAgentInput(t, w, AgentInput{ID: "epsilon-agent"})
	file, err := w.BuildAgentFile(AgentInput{ID: "epsilon-agent", Memory: "1gb"})
	if err != nil {
		t.Fatalf("BuildAgentFile: %v", err)
	}
	backupDir, err := w.WriteAgent("epsilon-agent", file)
	if err != nil {
		t.Fatalf("WriteAgent: %v", err)
	}

	want := filepath.Join(root, ".companion", "backups", "20260102T030405.000000000Z")
	if backupDir != want {
		t.Fatalf("backupDir = %q, want %q", backupDir, want)
	}
}

func TestTOMLWriterRestoreRollsBack(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	writeAgentInput(t, w, AgentInput{ID: "zeta-agent", Memory: "2gb"})
	original, err := os.ReadFile(w.AgentPath("zeta-agent"))
	if err != nil {
		t.Fatalf("read original: %v", err)
	}

	// Overwrite (captures a backup), then restore from it.
	file, err := w.BuildAgentFile(AgentInput{ID: "zeta-agent", Memory: "16gb"})
	if err != nil {
		t.Fatalf("BuildAgentFile: %v", err)
	}
	backupDir, err := w.WriteAgent("zeta-agent", file)
	if err != nil {
		t.Fatalf("WriteAgent: %v", err)
	}
	if err := w.Restore(backupDir); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	restored, err := os.ReadFile(w.AgentPath("zeta-agent"))
	if err != nil {
		t.Fatalf("read restored: %v", err)
	}
	if string(restored) != string(original) {
		t.Errorf("after restore content mismatch:\n got %q\nwant %q", restored, original)
	}
}

func TestTOMLWriterRemoveAgentRollsBackCreate(t *testing.T) {
	root := newTestWorkspace(t)
	w := NewTomlWriter(root, fixedClock(testStamp))

	writeAgentInput(t, w, AgentInput{ID: "eta-agent"})
	if err := w.RemoveAgent("eta-agent"); err != nil {
		t.Fatalf("RemoveAgent: %v", err)
	}
	if _, err := os.Stat(w.AgentPath("eta-agent")); !os.IsNotExist(err) {
		t.Fatalf("expected agent file removed, stat err = %v", err)
	}
	// Removing a missing file is tolerated.
	if err := w.RemoveAgent("eta-agent"); err != nil {
		t.Fatalf("RemoveAgent (missing) = %v, want nil", err)
	}
}

// richAgentTOML is a hand-authored agent file that uses fields the console form
// does NOT model (volume sizing, dashboard/granite settings, [api_server],
// [[vault_connections]]). The writer must preserve all of them across a
// structured update and a lifecycle=absent delete.
const richAgentTOML = `[agent]
id = "rich"
runtime = "fly.default"
network = "tailscale.default"
model_provider = "openrouter.default"
lifecycle = "present"
fly_app = "rich-app"
tailscale_hostname = "rich"
memory = "2gb"
volume_size_gb = 7
dashboard_mode = "serve"
granite_enabled = true
ts_extra_args = "--netfilter-mode=off"

[api_server]
enabled = true
port = 8642

[[vault_connections]]
name = "shared"
mode = "write"
host = "vault.local"
`

func writeRawAgent(t *testing.T, w *TomlWriter, id, content string) {
	t.Helper()
	p := w.AgentPath(id)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir agents: %v", err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
}

func readFileString(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(b)
}

// preservedKeys are the unmodeled tokens that must survive a console update or
// delete of richAgentTOML. We assert on key names and distinctive values rather
// than exact rendering, so the check is spacing/quote-agnostic.
var preservedKeys = []string{
	"volume_size_gb", "dashboard_mode", "granite_enabled",
	"ts_extra_args", "api_server", "8642", "vault_connections", "vault.local",
}

func TestTOMLWriterUpdatePreservesUnmodeledFields(t *testing.T) {
	root := t.TempDir()
	w := NewTomlWriter(root, fixedClock(testStamp))
	writeRawAgent(t, w, "rich", richAgentTOML)

	// Edit only memory through the structured form.
	file, err := w.MergeAgentFile("rich", AgentInput{ID: "rich", Memory: "4gb"})
	if err != nil {
		t.Fatalf("MergeAgentFile: %v", err)
	}
	if _, err := w.WriteAgent("rich", file); err != nil {
		t.Fatalf("WriteAgent: %v", err)
	}

	out := readFileString(t, w.AgentPath("rich"))
	if !strings.Contains(out, "4gb") {
		t.Fatalf("update did not apply memory=4gb:\n%s", out)
	}
	if strings.Contains(out, "2gb") {
		t.Fatalf("update left the stale memory value:\n%s", out)
	}
	for _, want := range preservedKeys {
		if !strings.Contains(out, want) {
			t.Fatalf("update dropped unmodeled field %q:\n%s", want, out)
		}
	}
	// The merged file must still parse as a valid agent file.
	var parsed agentTOMLFile
	if err := toml.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("merged file does not re-parse: %v", err)
	}
}

func TestTOMLWriterDeletePreservesUnmodeledFields(t *testing.T) {
	root := t.TempDir()
	w := NewTomlWriter(root, fixedClock(testStamp))
	writeRawAgent(t, w, "rich", richAgentTOML)

	if _, err := w.SetLifecycleAbsent("rich"); err != nil {
		t.Fatalf("SetLifecycleAbsent: %v", err)
	}

	out := readFileString(t, w.AgentPath("rich"))
	if !strings.Contains(out, "absent") {
		t.Fatalf("delete did not set lifecycle=absent:\n%s", out)
	}
	for _, want := range preservedKeys {
		if !strings.Contains(out, want) {
			t.Fatalf("delete dropped unmodeled field %q:\n%s", want, out)
		}
	}
}

func TestTOMLWriterRemoveSoulDropsFileAndEmptyDir(t *testing.T) {
	root := t.TempDir()
	w := NewTomlWriter(root, fixedClock(testStamp))

	if _, err := w.WriteSoul("gamma", "You are gamma."); err != nil {
		t.Fatalf("WriteSoul: %v", err)
	}
	if _, err := os.Stat(w.SoulPath("gamma")); err != nil {
		t.Fatalf("soul not written: %v", err)
	}
	if err := w.RemoveSoul("gamma"); err != nil {
		t.Fatalf("RemoveSoul: %v", err)
	}
	if _, err := os.Stat(w.SoulPath("gamma")); !os.IsNotExist(err) {
		t.Fatalf("soul file not removed, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Dir(w.SoulPath("gamma"))); !os.IsNotExist(err) {
		t.Fatalf("empty identity dir not removed, stat err = %v", err)
	}
	// Removing a missing soul is tolerated.
	if err := w.RemoveSoul("gamma"); err != nil {
		t.Fatalf("RemoveSoul (missing) = %v, want nil", err)
	}
}
