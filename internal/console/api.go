package console

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/provider"
	"github.com/The-Vibe-Company/companion/internal/resource"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/status"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

// soulPreviewLen bounds the soul preview returned in AgentDetail so the API
// never dumps a full identity (which may carry sensitive operating context).
const soulPreviewLen = 280

// handleWorkspace -> GET /api/console/workspace : WorkspaceInfo with provider
// credentials redacted to name + presence only.
func (s *Server) handleWorkspace(w http.ResponseWriter, r *http.Request) {
	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	env, err := s.env()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	creds := provider.New(ws, env).RequiredCredentials()
	providers := make([]ProviderCred, 0, len(creds))
	for _, c := range creds {
		// Names + presence only: a value never leaves the process.
		providers = append(providers, ProviderCred{Name: c.Name, Present: c.Present})
	}

	writeJSON(w, http.StatusOK, WorkspaceInfo{
		Name:       ws.Name,
		Root:       ws.Root,
		AgentCount: len(ws.Config.Agents),
		Providers:  providers,
	})
}

// handleListAgents -> GET /api/console/agents : []AgentSummary, built from config
// (no live network) and enriched from the latest status snapshot when available.
func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	byID := s.snapshotByID()
	summaries := make([]AgentSummary, 0, len(ws.Config.Agents))
	for _, agent := range ws.Config.Agents {
		summaries = append(summaries, s.agentSummary(agent, byID))
	}
	writeJSON(w, http.StatusOK, summaries)
}

// handleGetAgent -> GET /api/console/agents/{id} : AgentDetail (404 if unknown).
func (s *Server) handleGetAgent(w http.ResponseWriter, r *http.Request) {
	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	agent, ok := findAgent(ws.Config, r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusNotFound, "agent not found")
		return
	}
	writeJSON(w, http.StatusOK, s.agentDetail(agent, s.snapshotByID()))
}

// handleCreateAgent -> POST /api/console/agents : write agents/<id>.toml, reload
// + validate, and return 201 + AgentDetail. On validation failure the freshly
// created file is removed (rollback) and 400 is returned.
func (s *Server) handleCreateAgent(w http.ResponseWriter, r *http.Request) {
	var in AgentInput
	if err := decodeJSON(r, &in); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	id := strings.TrimSpace(in.ID)
	// Best-effort duplicate check: when the workspace already loads, reject a
	// colliding id. A workspace that does not yet load (e.g. it has no agents,
	// which Companion's "at least one agent" rule rejects) is allowed here so the
	// FIRST agent can be created; the post-write reload then validates it.
	if ws, err := s.loadWorkspace(); err == nil {
		if _, exists := findAgent(ws.Config, id); exists {
			writeJSONError(w, http.StatusConflict, "agent already exists: "+id)
			return
		}
	}

	file, err := s.writer.BuildAgentFile(in)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Write the optional SOUL.md first (so identity resolves on reload), then the
	// agent TOML. Both are fresh creates here, so rollback is a file removal.
	if strings.TrimSpace(in.Soul) != "" {
		if _, err := s.writer.WriteSoul(id, in.Soul); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if _, err := s.writer.WriteAgent(id, file); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	reloaded, err := s.reloadValidated()
	if err != nil {
		// Roll back the create: remove the just-written agent file so the broken
		// edit never persists in the workspace.
		_ = s.writer.RemoveAgent(id)
		writeJSONError(w, http.StatusBadRequest, "workspace validation failed: "+err.Error())
		return
	}

	agent, ok := findAgent(reloaded.Config, id)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "agent missing after create")
		return
	}
	writeJSON(w, http.StatusCreated, s.agentDetail(agent, s.snapshotByID()))
}

// handleUpdateAgent -> PUT /api/console/agents/{id} : overwrite agents/<id>.toml
// (with a backup), reload + validate, and return 200 + AgentDetail. On
// validation failure the prior file is restored from the backup.
func (s *Server) handleUpdateAgent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var in AgentInput
	if err := decodeJSON(r, &in); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	// The path id is authoritative; ignore any divergent body id.
	in.ID = id

	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, exists := findAgent(ws.Config, id); !exists {
		writeJSONError(w, http.StatusNotFound, "agent not found")
		return
	}

	file, err := s.writer.BuildAgentFile(in)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	var soulBackup string
	if strings.TrimSpace(in.Soul) != "" {
		soulBackup, err = s.writer.WriteSoul(id, in.Soul)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	agentBackup, err := s.writer.WriteAgent(id, file)
	if err != nil {
		s.rollback(soulBackup)
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	reloaded, err := s.reloadValidated()
	if err != nil {
		// Restore both files from their backups so a rejected edit leaves the
		// workspace exactly as it was.
		s.rollback(agentBackup)
		s.rollback(soulBackup)
		writeJSONError(w, http.StatusBadRequest, "workspace validation failed: "+err.Error())
		return
	}

	agent, ok := findAgent(reloaded.Config, id)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "agent missing after update")
		return
	}
	writeJSON(w, http.StatusOK, s.agentDetail(agent, s.snapshotByID()))
}

// handleDeleteAgent -> DELETE /api/console/agents/{id} : set lifecycle="absent"
// in the TOML (the file is kept so plan renders an explicit destroy) and return
// 200 + AgentDetail.
func (s *Server) handleDeleteAgent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, exists := findAgent(ws.Config, id); !exists {
		writeJSONError(w, http.StatusNotFound, "agent not found")
		return
	}

	backup, err := s.writer.SetLifecycleAbsent(id)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	reloaded, err := s.reloadValidated()
	if err != nil {
		s.rollback(backup)
		writeJSONError(w, http.StatusBadRequest, "workspace validation failed: "+err.Error())
		return
	}

	agent, ok := findAgent(reloaded.Config, id)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "agent missing after delete")
		return
	}
	writeJSON(w, http.StatusOK, s.agentDetail(agent, s.snapshotByID()))
}

// handlePlan -> POST /api/console/plan : reload the workspace, build the plan
// against current state and providers, cache the plan hash, and return
// PlanResponse. The cached hash is what a subsequent apply must echo back.
func (s *Server) handlePlan(w http.ResponseWriter, r *http.Request) {
	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	env, err := s.env()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	store, err := s.openStore(ws)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer store.Close()

	providers, err := provider.NewSet(ws, env, s.cmdRunner())
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	plan, err := resource.BuildPlan(r.Context(), ws, store, providers, s.planOptions(ws, env))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}

	planJSON, err := plan.JSON()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	hash := hashBytes(planJSON)
	s.setPlanHash(hash)

	writeJSON(w, http.StatusOK, PlanResponse{
		Hash:    hash,
		Text:    plan.String(),
		Changes: planChanges(plan.Changes),
	})
}

// handleApply -> POST /api/console/apply : require the supplied hash to match the
// most recent plan hash (else 409 stale), then start a single async apply (409
// when one is already active) and return 202 + ApplyResponse.
func (s *Server) handleApply(w http.ResponseWriter, r *http.Request) {
	var req ApplyRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	latest := s.planHash()
	if latest == "" {
		writeJSONError(w, http.StatusConflict, "no current plan: run plan before apply")
		return
	}
	if strings.TrimSpace(req.Hash) != latest {
		writeJSONError(w, http.StatusConflict, "stale plan: re-run plan and apply the current hash")
		return
	}

	id, ok := s.runner.Start(s.applyRun())
	if !ok {
		writeJSONError(w, http.StatusConflict, "an apply is already in progress")
		return
	}
	writeJSON(w, http.StatusAccepted, ApplyResponse{OperationID: id})
}

// applyRun returns the function the OperationRunner executes for an apply. It
// reloads the workspace, state, and providers fresh, runs resource.Apply, and
// reports the addresses that actually mutated plus the canonical plan JSON.
func (s *Server) applyRun() func(ctx context.Context) (changed []string, planJSON []byte, err error) {
	return func(ctx context.Context) ([]string, []byte, error) {
		ws, err := s.loadWorkspace()
		if err != nil {
			return nil, nil, err
		}
		env, err := s.env()
		if err != nil {
			return nil, nil, err
		}
		store, err := s.openStore(ws)
		if err != nil {
			return nil, nil, err
		}
		defer store.Close()

		providers, err := provider.NewSet(ws, env, s.cmdRunner())
		if err != nil {
			return nil, nil, err
		}

		plan, err := resource.Apply(ctx, ws, store, providers, s.planOptions(ws, env))
		planJSON, jerr := plan.JSON()
		if jerr != nil && err == nil {
			err = jerr
		}
		return mutatedAddresses(plan.Changes), planJSON, err
	}
}

// handleGetOperation -> GET /api/console/operations/{id} : OperationStatus (404
// if the id is unknown).
func (s *Server) handleGetOperation(w http.ResponseWriter, r *http.Request) {
	op, ok := s.runner.Get(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusNotFound, "operation not found")
		return
	}
	writeJSON(w, http.StatusOK, operationStatus(op))
}

// handleListApplies -> GET /api/console/applies : []ApplyHistoryEntry, newest
// first, read from the workspace state applies table.
func (s *Server) handleListApplies(w http.ResponseWriter, r *http.Request) {
	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	store, err := s.openStore(ws)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer store.Close()

	entries, err := NewHistory(store).List(r.Context(), 50)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// handleAgentLogs -> GET /api/console/agents/{id}/logs : recent offline state
// events for the agent (subject = id). Live Fly/agent task logs are a later
// Hermes feature; no live provider call is made here.
func (s *Server) handleAgentLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	ws, err := s.loadWorkspace()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, exists := findAgent(ws.Config, id); !exists {
		writeJSONError(w, http.StatusNotFound, "agent not found")
		return
	}
	store, err := s.openStore(ws)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer store.Close()

	lines, err := recentAgentEvents(r.Context(), store, id, 100)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, LogsResponse{
		AgentID: id,
		Lines:   lines,
		Source:  "state-events",
		Note:    "Live Fly/agent task logs are a later Hermes feature.",
	})
}

// --- shared helpers -------------------------------------------------------

// planOptions builds the resource Options used for both plan and apply so the
// two stay consistent (same generated dir and env).
func (s *Server) planOptions(ws *workspace.Workspace, env map[string]string) resource.Options {
	return resource.Options{
		Root:         ws.Root,
		GeneratedDir: filepath.Join(ws.Root, ".companion", "generated"),
		Env:          env,
	}
}

// reloadValidated re-loads the workspace from disk. workspace.Load already runs
// Validate, so a successful reload proves the just-written files form a valid
// workspace; a non-nil error is the signal to roll back.
func (s *Server) reloadValidated() (*workspace.Workspace, error) {
	return s.loadWorkspace()
}

// rollback restores files from a backup dir, best effort. A blank dir (a fresh
// create with no prior file) is a no-op.
func (s *Server) rollback(backupDir string) {
	if backupDir == "" {
		return
	}
	_ = s.writer.Restore(backupDir)
}

// snapshotByID indexes the latest status snapshot services by id for agent
// enrichment. It returns nil when no poller/snapshot is available, in which case
// summaries carry only config-derived fields.
func (s *Server) snapshotByID() map[string]status.ServiceStatus {
	if s.poller == nil {
		return nil
	}
	snapshot := s.poller.Snapshot()
	if len(snapshot.Services) == 0 {
		return nil
	}
	byID := make(map[string]status.ServiceStatus, len(snapshot.Services))
	for _, svc := range snapshot.Services {
		byID[svc.ID] = svc
	}
	return byID
}

// agentSummary builds the list-row view for an agent, enriched from the snapshot
// service of the same id when present.
func (s *Server) agentSummary(agent config.Agent, byID map[string]status.ServiceStatus) AgentSummary {
	summary := AgentSummary{
		ID:                agent.ID,
		Model:             agent.Model.Default,
		FlyApp:            agent.FlyApp,
		TailscaleHostname: agent.TailscaleHostname,
		Vault:             agent.DefaultVault.Name,
		Lifecycle:         agent.Lifecycle,
	}
	if svc, ok := byID[agent.ID]; ok {
		summary.Health = svc.Health
		summary.FlyState = svc.MachineState
		summary.URL = svc.URL
	}
	return summary
}

// agentDetail builds the full single-agent view. The soul preview is a short,
// redacted prefix of the effective identity, never the full text.
func (s *Server) agentDetail(agent config.Agent, byID map[string]status.ServiceStatus) AgentDetail {
	vaultConnections := make([]string, 0, len(agent.VaultConnections))
	for _, vc := range agent.VaultConnections {
		vaultConnections = append(vaultConnections, vc.Name)
	}
	return AgentDetail{
		AgentSummary:         s.agentSummary(agent, byID),
		Region:               agent.Region,
		Memory:               agent.Memory,
		CPUs:                 agent.CPUs,
		Runtime:              agent.Runtime,
		Network:              agent.Network,
		ModelProvider:        agent.ModelProvider,
		SoulPreview:          s.soulPreview(agent),
		CompanionSoulEnabled: agent.CompanionSoul.Enabled,
		VaultConnections:     vaultConnections,
	}
}

// soulPreview returns a short, single-line prefix of the agent's effective
// identity for display. It reads the SOUL.md from disk when the identity is
// file-backed, then truncates; it never returns the full soul.
func (s *Server) soulPreview(agent config.Agent) string {
	if !agent.Identity.Enabled {
		return ""
	}
	soul := agent.Identity.Soul
	if strings.TrimSpace(soul) == "" && agent.Identity.Path != "" {
		path := agent.Identity.Path
		if !filepath.IsAbs(path) {
			path = filepath.Join(s.opts.WorkspaceDir, filepath.FromSlash(path))
		}
		if data, err := os.ReadFile(path); err == nil {
			soul = string(data)
		}
	}
	return truncatePreview(soul, soulPreviewLen)
}

// findAgent returns the config agent with the given id.
func findAgent(cfg *config.Config, id string) (config.Agent, bool) {
	id = strings.TrimSpace(id)
	for _, agent := range cfg.Agents {
		if agent.ID == id {
			return agent, true
		}
	}
	return config.Agent{}, false
}

// planChanges maps engine changes to the redacted PlanChange DTO.
func planChanges(changes []resource.Change) []PlanChange {
	out := make([]PlanChange, 0, len(changes))
	for _, c := range changes {
		out = append(out, PlanChange{
			Kind:      c.Kind,
			Action:    c.Action,
			Address:   c.Address,
			Message:   c.Message,
			Protected: c.Protected,
		})
	}
	return out
}

// mutatedAddresses returns the addresses of changes that actually mutate the
// fleet (create/update/delete), excluding no-ops and informational rows. This is
// what the operation reports as changed_resources.
func mutatedAddresses(changes []resource.Change) []string {
	out := []string{}
	for _, c := range changes {
		switch c.Kind {
		case "+", "~", "-":
			out = append(out, c.Address)
		}
	}
	return out
}

// operationStatus maps the in-memory Operation to its JSON status DTO. Times are
// rendered as RFC3339 strings (empty when zero).
func operationStatus(op Operation) OperationStatus {
	changed := op.Changed
	if changed == nil {
		changed = []string{}
	}
	st := OperationStatus{
		ID:               op.ID,
		State:            op.State,
		ChangedResources: changed,
		Error:            op.Error,
	}
	if !op.StartedAt.IsZero() {
		st.StartedAt = op.StartedAt.UTC().Format(rfc3339)
	}
	if !op.FinishedAt.IsZero() {
		st.FinishedAt = op.FinishedAt.UTC().Format(rfc3339)
	}
	return st
}

// recentAgentEvents reads up to limit recent state events whose subject matches
// the agent id, newest first, and formats each as a single log line. A missing
// events table yields an empty slice rather than an error.
func recentAgentEvents(ctx context.Context, store *state.Store, id string, limit int) ([]string, error) {
	lines := []string{}
	if store == nil || store.DB == nil {
		return lines, nil
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := store.DB.QueryContext(
		ctx,
		`SELECT timestamp, command, level, message
		 FROM events
		 WHERE subject = ?
		 ORDER BY id DESC
		 LIMIT ?`,
		id, limit,
	)
	if err != nil {
		if isMissingTable(err) {
			return lines, nil
		}
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var ts, command, level, message sql.NullString
		if err := rows.Scan(&ts, &command, &level, &message); err != nil {
			return nil, err
		}
		lines = append(lines, formatEventLine(ts.String, command.String, level.String, message.String))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

// formatEventLine renders one state event as a compact, human-readable log line.
func formatEventLine(ts, command, level, message string) string {
	parts := make([]string, 0, 4)
	if ts != "" {
		parts = append(parts, ts)
	}
	if level != "" {
		parts = append(parts, strings.ToUpper(level))
	}
	if command != "" {
		parts = append(parts, command)
	}
	if message != "" {
		parts = append(parts, message)
	}
	return strings.Join(parts, " ")
}

// truncatePreview returns a single-line prefix of s of at most n runes, with an
// ellipsis when truncated. Newlines are collapsed to spaces so previews stay
// one line.
func truncatePreview(s string, n int) string {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", " "), "\n", " "))
	if s == "" {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return strings.TrimSpace(string(runes[:n])) + "…"
}

// hashBytes returns the sha256 hex digest of b. It is the plan-hash function
// shared by plan (which caches it) and apply (which must echo it).
func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// setPlanHash records the latest computed plan hash under the server mutex.
func (s *Server) setPlanHash(hash string) {
	s.mu.Lock()
	s.latestPlanHash = hash
	s.mu.Unlock()
}

// planHash returns the most recently computed plan hash under the server mutex.
func (s *Server) planHash() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.latestPlanHash
}

// rfc3339 is the timestamp layout used for operation times in API responses.
const rfc3339 = "2006-01-02T15:04:05Z07:00"
