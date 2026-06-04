package console

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

// Sentinel secret VALUES injected into the test env. The console must surface
// credential NAMES and presence only; these literal values must never appear in
// any API response body. Asserting their absence is the redaction contract.
const (
	secretOpenRouterValue = "sk-or-REDACT-ME-0123456789"
	secretTSAuthKeyValue  = "tskey-auth-REDACT-ME-abcdef"
	secretAPIServerValue  = "apisrv-REDACT-ME-zzz"
)

// testEnv is the explicit, hermetic environment injected into every console
// Server under test. It carries the secret values whose NAMES (and only names)
// the redacted API may expose, plus the secrets a full apply needs to render.
func testEnv() map[string]string {
	return map[string]string{
		"OPENROUTER_API_KEY": secretOpenRouterValue,
		"TS_AUTHKEY":         secretTSAuthKeyValue,
		"API_SERVER_KEY":     secretAPIServerValue,
	}
}

// seededAgentTOML mirrors examples/minimal/agents/example-agent.toml so the
// seeded workspace loads + validates with a real agent present.
const seededAgentTOML = `[agent]
id = "example-agent"
runtime = "fly.default"
network = "tailscale.default"
model_provider = "openrouter.default"
lifecycle = "present"
protect = true
fly_app = "example-companion-agent"
tailscale_hostname = "example-agent"

[default_vault]
enabled = true
name = "Example Agent"
mcp_role = "write"
`

// seededWorkspace builds a complete temp workspace (via the shared
// newTestWorkspace helper) and writes one valid agent into it, so list/detail/
// plan/apply have something real to operate on. It returns the workspace root.
func seededWorkspace(t *testing.T) string {
	t.Helper()
	root := newTestWorkspace(t)
	writeWS(t, root, "agents/example-agent.toml", seededAgentTOML)
	// Sanity: the seeded workspace must load+validate before any test uses it.
	if _, err := workspace.Load(root); err != nil {
		t.Fatalf("seeded workspace does not load: %v", err)
	}
	return root
}

// newTestServer builds a console Server rooted at the given workspace with an
// injected env, FakeRunner, and the deterministic test clock. The FakeRunner
// answers `tailscale status --json` with an empty object so device enumeration
// (used by plan/apply) parses without a live tailnet; all other commands return
// ExitCode 0 with empty output, which the Fly CLI provider treats as success.
func newTestServer(t *testing.T, root string, runner execx.Runner) *Server {
	t.Helper()
	if runner == nil {
		runner = &execx.FakeRunner{Responses: map[string]execx.Result{
			"tailscale status --json": {Stdout: `{}`},
		}}
	}
	srv, err := NewServer(Options{
		WorkspaceDir: root,
		Env:          testEnv(),
		Runner:       runner,
		Clock:        fixedClock(testStamp),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return srv
}

// do issues a request against the server handler and returns the recorder. When
// token is non-empty it is sent as the X-Console-Token header.
func do(t *testing.T, srv *Server, method, target string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	if token != "" {
		req.Header.Set("X-Console-Token", token)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// decode unmarshals a recorder body into v, failing the test on error.
func decode(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode response (%s): %v", rec.Body.String(), err)
	}
}

// assertNoSecretValues fails if any injected secret VALUE leaked into the body.
func assertNoSecretValues(t *testing.T, body string) {
	t.Helper()
	for _, secret := range []string{secretOpenRouterValue, secretTSAuthKeyValue, secretAPIServerValue} {
		if strings.Contains(body, secret) {
			t.Fatalf("response body leaked a secret value %q:\n%s", secret, body)
		}
	}
}

func TestWorkspaceEndpointRedactsProviders(t *testing.T) {
	srv := newTestServer(t, seededWorkspace(t), nil)

	rec := do(t, srv, http.MethodGet, "/api/console/workspace", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}

	// The whole point: names + presence only, never a value.
	assertNoSecretValues(t, rec.Body.String())

	var info WorkspaceInfo
	decode(t, rec, &info)
	if info.AgentCount != 1 {
		t.Fatalf("agent_count = %d, want 1", info.AgentCount)
	}
	if len(info.Providers) == 0 {
		t.Fatalf("expected redacted provider credentials, got none")
	}
	// The default workspace uses cli-mode providers, which surface the Tailscale
	// auth key secret and the OpenRouter api key env as required credential names.
	byName := map[string]bool{}
	for _, p := range info.Providers {
		byName[p.Name] = p.Present
	}
	for _, want := range []string{"OPENROUTER_API_KEY", "TS_AUTHKEY"} {
		present, ok := byName[want]
		if !ok {
			t.Fatalf("missing redacted credential %q in %#v", want, info.Providers)
		}
		if !present {
			t.Fatalf("credential %q present = false, want true (value injected via env)", want)
		}
	}
}

func TestListAgentsWithoutNetwork(t *testing.T) {
	// A FakeRunner with no responses at all proves listing never touches the
	// network: it must build purely from config.
	srv := newTestServer(t, seededWorkspace(t), &execx.FakeRunner{})

	rec := do(t, srv, http.MethodGet, "/api/console/agents", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecretValues(t, rec.Body.String())

	var agents []AgentSummary
	decode(t, rec, &agents)
	if len(agents) != 1 {
		t.Fatalf("agent count = %d, want 1: %#v", len(agents), agents)
	}
	got := agents[0]
	if got.ID != "example-agent" {
		t.Errorf("id = %q, want example-agent", got.ID)
	}
	if got.FlyApp != "example-companion-agent" {
		t.Errorf("fly_app = %q, want example-companion-agent", got.FlyApp)
	}
	if got.Lifecycle != "present" {
		t.Errorf("lifecycle = %q, want present", got.Lifecycle)
	}
	// No poller is attached in these tests, so live-only fields stay zero.
	if got.Health != "" || got.FlyState != "" {
		t.Errorf("expected zero live fields without a poller, got health=%q fly_state=%q", got.Health, got.FlyState)
	}
}

func TestGetAgentDetail(t *testing.T) {
	srv := newTestServer(t, seededWorkspace(t), &execx.FakeRunner{})

	rec := do(t, srv, http.MethodGet, "/api/console/agents/example-agent", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var detail AgentDetail
	decode(t, rec, &detail)
	if detail.ID != "example-agent" {
		t.Errorf("id = %q, want example-agent", detail.ID)
	}
	if detail.Runtime != "fly.default" || detail.Network != "tailscale.default" {
		t.Errorf("runtime/network = %q/%q, want fly.default/tailscale.default", detail.Runtime, detail.Network)
	}
	if detail.Vault != "Example Agent" {
		t.Errorf("vault = %q, want Example Agent", detail.Vault)
	}

	// Unknown id is a 404.
	miss := do(t, srv, http.MethodGet, "/api/console/agents/nope", nil, "")
	if miss.Code != http.StatusNotFound {
		t.Fatalf("GET unknown agent status = %d, want 404", miss.Code)
	}
}

func TestCreateAgentWritesFileAndValidates(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, &execx.FakeRunner{})

	in := AgentInput{
		ID:                "alpha-agent",
		Model:             "anthropic/claude-3.7-sonnet",
		FlyApp:            "alpha-companion-agent",
		TailscaleHostname: "alpha-agent",
		VaultName:         "Alpha Vault",
	}
	rec := do(t, srv, http.MethodPost, "/api/console/agents", in, srv.Token())
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecretValues(t, rec.Body.String())

	var detail AgentDetail
	decode(t, rec, &detail)
	if detail.ID != "alpha-agent" {
		t.Errorf("created id = %q, want alpha-agent", detail.ID)
	}

	// The agent file exists on disk and the workspace still loads + validates.
	agentPath := filepath.Join(root, "agents", "alpha-agent.toml")
	if _, err := os.Stat(agentPath); err != nil {
		t.Fatalf("expected agents/alpha-agent.toml to exist: %v", err)
	}
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load after create: %v", err)
	}
	if _, ok := findAgent(ws.Config, "alpha-agent"); !ok {
		t.Fatalf("created agent missing from reloaded workspace")
	}

	// A fresh create must NOT require (or produce) a backup directory: there was
	// no prior file to back up.
	backups := filepath.Join(root, ".companion", "backups")
	if entries, err := os.ReadDir(backups); err == nil && len(entries) != 0 {
		t.Fatalf("fresh create should not write a backup, found %d entries under %s", len(entries), backups)
	}
}

func TestCreateAgentRequiresSessionToken(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, &execx.FakeRunner{})

	in := AgentInput{ID: "beta-agent"}

	// No token -> 403, and nothing is written.
	rec := do(t, srv, http.MethodPost, "/api/console/agents", in, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing-token status = %d, want 403, body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "agents", "beta-agent.toml")); !os.IsNotExist(err) {
		t.Fatalf("forbidden create must not write a file (stat err=%v)", err)
	}

	// Wrong token -> 403.
	bad := do(t, srv, http.MethodPost, "/api/console/agents", in, "not-the-token")
	if bad.Code != http.StatusForbidden {
		t.Fatalf("wrong-token status = %d, want 403", bad.Code)
	}

	// Correct token -> 201.
	ok := do(t, srv, http.MethodPost, "/api/console/agents", in, srv.Token())
	if ok.Code != http.StatusCreated {
		t.Fatalf("valid-token status = %d, want 201, body=%s", ok.Code, ok.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "agents", "beta-agent.toml")); err != nil {
		t.Fatalf("valid create did not write file: %v", err)
	}
}

func TestUpdateAgentBacksUpOldContents(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, &execx.FakeRunner{})

	agentPath := filepath.Join(root, "agents", "example-agent.toml")
	original, err := os.ReadFile(agentPath)
	if err != nil {
		t.Fatalf("read seeded agent: %v", err)
	}

	in := AgentInput{
		ID:                "example-agent",
		FlyApp:            "example-companion-agent",
		TailscaleHostname: "example-agent",
		Memory:            "8gb",
		VaultName:         "Example Agent",
	}
	rec := do(t, srv, http.MethodPut, "/api/console/agents/example-agent", in, srv.Token())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}

	var detail AgentDetail
	decode(t, rec, &detail)
	if detail.Memory != "8gb" {
		t.Errorf("memory = %q, want 8gb", detail.Memory)
	}

	// The PUT must have produced a timestamped backup (fixed clock) holding the
	// OLD contents, so a bad edit can be rolled back.
	backupFile := filepath.Join(root, ".companion", "backups", backupStamp(testStamp), "agents", "example-agent.toml")
	saved, err := os.ReadFile(backupFile)
	if err != nil {
		t.Fatalf("expected backup at %s: %v", backupFile, err)
	}
	if !bytes.Equal(saved, original) {
		t.Fatalf("backup content mismatch:\n got %q\nwant %q", saved, original)
	}

	// The live workspace reflects the update.
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load after update: %v", err)
	}
	agent, _ := findAgent(ws.Config, "example-agent")
	if agent.Memory != "8gb" {
		t.Errorf("reloaded memory = %q, want 8gb", agent.Memory)
	}
}

func TestDeleteAgentSetsLifecycleAbsentKeepsFile(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, &execx.FakeRunner{})

	rec := do(t, srv, http.MethodDelete, "/api/console/agents/example-agent", nil, srv.Token())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var detail AgentDetail
	decode(t, rec, &detail)
	if detail.Lifecycle != "absent" {
		t.Errorf("lifecycle = %q, want absent", detail.Lifecycle)
	}

	// DELETE is soft: the file must still exist.
	agentPath := filepath.Join(root, "agents", "example-agent.toml")
	if _, err := os.Stat(agentPath); err != nil {
		t.Fatalf("agent file must remain after delete: %v", err)
	}
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("workspace.Load after delete: %v", err)
	}
	agent, _ := findAgent(ws.Config, "example-agent")
	if agent.Lifecycle != "absent" {
		t.Errorf("reloaded lifecycle = %q, want absent", agent.Lifecycle)
	}
}

func TestCreateAgentRejectsInvalidID(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, &execx.FakeRunner{})

	cases := []struct {
		name string
		id   string
	}{
		{"traversal", "../evil"},
		{"underscore", "Bad_ID"},
		{"uppercase", "BadID"},
		{"slash", "team/agent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(t, srv, http.MethodPost, "/api/console/agents", AgentInput{ID: tc.id}, srv.Token())
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
			}
		})
	}

	// Nothing should have been written beyond the single seeded agent.
	entries, err := os.ReadDir(filepath.Join(root, "agents"))
	if err != nil {
		t.Fatalf("read agents dir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("invalid ids must not write files, found %d agent files: %v", len(entries), entries)
	}
	// And the traversal target must not have escaped the workspace.
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "evil.toml")); err == nil {
		t.Fatalf("path traversal escaped the workspace")
	}
}

func TestPlanReturnsHashAndApplyGuardsStaleHash(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, nil)

	// POST /plan computes and caches a hash.
	planRec := do(t, srv, http.MethodPost, "/api/console/plan", nil, srv.Token())
	if planRec.Code != http.StatusOK {
		t.Fatalf("plan status = %d, want 200, body=%s", planRec.Code, planRec.Body.String())
	}
	assertNoSecretValues(t, planRec.Body.String())

	var plan PlanResponse
	decode(t, planRec, &plan)
	if plan.Hash == "" {
		t.Fatalf("plan returned empty hash")
	}
	// A brand-new fleet must show creates.
	if len(plan.Changes) == 0 {
		t.Fatalf("expected plan changes for an unrealized fleet, got none: %s", plan.Text)
	}

	// Apply with a WRONG hash is rejected as stale (409) and starts nothing.
	stale := do(t, srv, http.MethodPost, "/api/console/apply", ApplyRequest{Hash: "deadbeef"}, srv.Token())
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale apply status = %d, want 409, body=%s", stale.Code, stale.Body.String())
	}

	// Apply with the correct hash is accepted (202) and yields a pollable op.
	ok := do(t, srv, http.MethodPost, "/api/console/apply", ApplyRequest{Hash: plan.Hash}, srv.Token())
	if ok.Code != http.StatusAccepted {
		t.Fatalf("apply status = %d, want 202, body=%s", ok.Code, ok.Body.String())
	}
	var applied ApplyResponse
	decode(t, ok, &applied)
	if applied.OperationID == "" {
		t.Fatalf("apply returned empty operation_id")
	}

	// The operation must converge to a terminal state and be retrievable. The
	// FakeRunner drives every Fly command to success, so it should succeed.
	op := waitForOperation(t, srv, applied.OperationID, OpSucceeded)
	if op.State != OpSucceeded {
		t.Fatalf("operation state = %q, want succeeded (error=%q)", op.State, op.Error)
	}
	if len(op.ChangedResources) == 0 {
		t.Fatalf("expected changed resources after apply, got none")
	}
}

func TestApplyRejectsBeforeAnyPlan(t *testing.T) {
	srv := newTestServer(t, seededWorkspace(t), nil)

	rec := do(t, srv, http.MethodPost, "/api/console/apply", ApplyRequest{Hash: "anything"}, srv.Token())
	if rec.Code != http.StatusConflict {
		t.Fatalf("apply-before-plan status = %d, want 409, body=%s", rec.Code, rec.Body.String())
	}
}

func TestConcurrentApplyReturns409(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, nil)

	// Occupy the single apply slot with a long-running operation we control, so
	// the conflict window is deterministic (no timing reliance).
	release := make(chan struct{})
	started := make(chan struct{})
	id, ok := srv.runner.Start(func(ctx context.Context) ([]string, []byte, error) {
		close(started)
		<-release
		return nil, []byte(`{"changes":[]}`), nil
	})
	if !ok {
		t.Fatalf("failed to occupy the apply slot")
	}
	<-started
	defer func() {
		close(release)
		waitForOperation(t, srv, id, OpSucceeded)
	}()

	// Compute a valid plan hash so the apply passes the stale-hash gate and is
	// rejected specifically by the single-active-apply lock (409 conflict).
	planRec := do(t, srv, http.MethodPost, "/api/console/plan", nil, srv.Token())
	if planRec.Code != http.StatusOK {
		t.Fatalf("plan status = %d, body=%s", planRec.Code, planRec.Body.String())
	}
	var plan PlanResponse
	decode(t, planRec, &plan)

	rec := do(t, srv, http.MethodPost, "/api/console/apply", ApplyRequest{Hash: plan.Hash}, srv.Token())
	if rec.Code != http.StatusConflict {
		t.Fatalf("second concurrent apply status = %d, want 409, body=%s", rec.Code, rec.Body.String())
	}
}

func TestAppliesHistoryNewestFirst(t *testing.T) {
	root := seededWorkspace(t)

	// Seed apply history directly into the workspace state before serving.
	ws, err := workspace.Load(root)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	store, err := state.Open(ws.StatePath)
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	ctx := context.Background()
	firstID, err := store.StartApply(ctx, map[string]any{"changes": 1})
	if err != nil {
		t.Fatalf("start first apply: %v", err)
	}
	if err := store.FinishApply(ctx, firstID, "succeeded"); err != nil {
		t.Fatalf("finish first apply: %v", err)
	}
	secondID, err := store.StartApply(ctx, map[string]any{"changes": 2})
	if err != nil {
		t.Fatalf("start second apply: %v", err)
	}
	if err := store.FinishApply(ctx, secondID, "failed"); err != nil {
		t.Fatalf("finish second apply: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close state: %v", err)
	}

	srv := newTestServer(t, root, &execx.FakeRunner{})
	rec := do(t, srv, http.MethodGet, "/api/console/applies", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}

	var entries []ApplyHistoryEntry
	decode(t, rec, &entries)
	if len(entries) != 2 {
		t.Fatalf("expected two history entries, got %d: %#v", len(entries), entries)
	}
	// Newest first.
	if entries[0].ID != secondID || entries[1].ID != firstID {
		t.Fatalf("history order wrong: got ids %d,%d want %d,%d", entries[0].ID, entries[1].ID, secondID, firstID)
	}
	if entries[0].Status != "failed" || entries[1].Status != "succeeded" {
		t.Fatalf("history statuses wrong: %#v", entries)
	}
}

func TestAgentLogsOfflineNote(t *testing.T) {
	srv := newTestServer(t, seededWorkspace(t), &execx.FakeRunner{})

	rec := do(t, srv, http.MethodGet, "/api/console/agents/example-agent/logs", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	assertNoSecretValues(t, rec.Body.String())

	var logs LogsResponse
	decode(t, rec, &logs)
	if logs.AgentID != "example-agent" {
		t.Errorf("agent_id = %q, want example-agent", logs.AgentID)
	}
	if logs.Source != "state-events" {
		t.Errorf("source = %q, want state-events", logs.Source)
	}
	if !strings.Contains(logs.Note, "later Hermes feature") {
		t.Errorf("note = %q, want the offline note mentioning the later Hermes feature", logs.Note)
	}
	if logs.Lines == nil {
		t.Errorf("lines must be a non-nil (possibly empty) slice")
	}

	// Unknown agent logs -> 404.
	miss := do(t, srv, http.MethodGet, "/api/console/agents/ghost/logs", nil, "")
	if miss.Code != http.StatusNotFound {
		t.Fatalf("logs for unknown agent status = %d, want 404", miss.Code)
	}
}

func TestHealthzAndIndexInjectToken(t *testing.T) {
	srv := newTestServer(t, seededWorkspace(t), &execx.FakeRunner{})

	health := do(t, srv, http.MethodGet, "/healthz", nil, "")
	if health.Code != http.StatusOK || strings.TrimSpace(health.Body.String()) != "ok" {
		t.Fatalf("healthz = (%d, %q), want (200, ok)", health.Code, health.Body.String())
	}

	index := do(t, srv, http.MethodGet, "/", nil, "")
	if index.Code != http.StatusOK {
		t.Fatalf("index status = %d, want 200", index.Code)
	}
	body := index.Body.String()
	// The served UI must carry the real session token so the SPA can send it on
	// mutating calls...
	if !strings.Contains(body, srv.Token()) {
		t.Fatalf("served index did not inject the session token")
	}
	// ...and the raw sentinel must be fully replaced, never shipped to the page.
	if strings.Contains(body, "%%CONSOLE_TOKEN%%") {
		t.Fatalf("served index still contains the raw token sentinel:\n%s", body)
	}
	if strings.Contains(body, "%%CONSOLE_WORKSPACE%%") {
		t.Fatalf("served index still contains the raw workspace sentinel:\n%s", body)
	}
}

// waitForOperation polls the API operation endpoint until the operation reaches
// the wanted terminal state or the bounded retry budget is exhausted. The runner
// goroutine drives convergence; the loop is only a failure guard.
func waitForOperation(t *testing.T, srv *Server, id, want string) OperationStatus {
	t.Helper()
	for i := 0; i < 2000; i++ {
		rec := do(t, srv, http.MethodGet, "/api/console/operations/"+id, nil, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET operation %s status = %d, body=%s", id, rec.Code, rec.Body.String())
		}
		var op OperationStatus
		decode(t, rec, &op)
		if op.State == want || op.State == OpSucceeded || op.State == OpFailed {
			return op
		}
	}
	t.Fatalf("operation %s did not reach %q in time", id, want)
	return OperationStatus{}
}

// TestCreateAgentRollbackRemovesOrphanSoul verifies that when a create writes a
// SOUL.md but the resulting workspace fails to validate, BOTH the agent file and
// the orphan SOUL.md are rolled back. The agent passes the writer's build-time
// name checks but references an undefined fly provider, which only the post-write
// workspace reload rejects — exercising the soul-rollback path.
func TestCreateAgentRollbackRemovesOrphanSoul(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, &execx.FakeRunner{})

	in := AgentInput{
		ID:                "broken",
		FlyApp:            "broken-app",
		TailscaleHostname: "broken",
		Runtime:           "fly.doesnotexist", // valid shape; undefined provider -> reload fails
		Soul:              "You are broken.",
	}
	rec := do(t, srv, http.MethodPost, "/api/console/agents", in, srv.Token())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create with undefined provider = %d, want 400: %s", rec.Code, rec.Body.String())
	}

	if _, err := os.Stat(filepath.Join(root, "agents", "broken.toml")); !os.IsNotExist(err) {
		t.Fatalf("rolled-back create left an agent file (stat err = %v)", err)
	}
	if _, err := os.Stat(filepath.Join(root, "identities", "broken", "SOUL.md")); !os.IsNotExist(err) {
		t.Fatalf("rolled-back create left an orphan SOUL.md (stat err = %v)", err)
	}
}

func hasBlockedChange(changes []PlanChange) bool {
	for _, c := range changes {
		if c.Kind == "!" {
			return true
		}
	}
	return false
}

// TestPlanBlocksProtectedDestroyUntilConfirmed verifies the destroy-confirmation
// flow: marking a protected agent absent makes a plain plan report its managed
// resources as blocked (requiring explicit confirmation), and re-planning with
// the destroy confirmations turns those blocks into real deletes.
func TestPlanBlocksProtectedDestroyUntilConfirmed(t *testing.T) {
	root := seededWorkspace(t)
	srv := newTestServer(t, root, &execx.FakeRunner{})

	// Mark the protected agent absent so its managed resources are slated for
	// destruction.
	del := do(t, srv, http.MethodDelete, "/api/console/agents/example-agent", nil, srv.Token())
	if del.Code != http.StatusOK {
		t.Fatalf("delete (mark absent) = %d: %s", del.Code, del.Body.String())
	}

	// A plain plan reports the protected destroys as blocked and asks for explicit
	// confirmation; it must not silently destroy anything.
	rec := do(t, srv, http.MethodPost, "/api/console/plan", PlanRequest{}, srv.Token())
	if rec.Code != http.StatusOK {
		t.Fatalf("plan = %d: %s", rec.Code, rec.Body.String())
	}
	var p PlanResponse
	decode(t, rec, &p)
	if !p.RequiresProtectedConfirm {
		t.Fatalf("plan should require protected confirmation; changes=%+v", p.Changes)
	}
	if !hasBlockedChange(p.Changes) {
		t.Fatalf("plan should contain a blocked (!) change before confirmation:\n%s", p.Text)
	}
	if !p.RequiresDestroyData {
		t.Fatalf("plan destroying a fly_volume should require the persistent-data confirmation")
	}

	// Confirming unblocks the destroy: re-plan with both confirmations and the
	// blocked items become real deletes, with a distinct hash.
	rec2 := do(t, srv, http.MethodPost, "/api/console/plan",
		PlanRequest{AllowProtectedDestroy: true, DestroyData: true}, srv.Token())
	if rec2.Code != http.StatusOK {
		t.Fatalf("confirmed plan = %d: %s", rec2.Code, rec2.Body.String())
	}
	var p2 PlanResponse
	decode(t, rec2, &p2)
	if hasBlockedChange(p2.Changes) {
		t.Fatalf("confirmed plan must not contain blocked changes:\n%s", p2.Text)
	}
	if p2.Hash == p.Hash {
		t.Fatalf("confirmed plan hash should differ from the blocked plan hash")
	}
}
