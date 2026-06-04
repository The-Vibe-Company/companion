package console

import (
	"encoding/json"
	"time"
)

// WorkspaceInfo summarizes the loaded workspace for the console UI. Provider
// credentials are redacted to names + presence only; secret values never leave
// the process.
type WorkspaceInfo struct {
	Name       string         `json:"name"`
	Root       string         `json:"root"`
	AgentCount int            `json:"agent_count"`
	Providers  []ProviderCred `json:"providers"`
}

// ProviderCred is a redacted provider credential: the environment variable name
// and whether it is currently present, never the value.
type ProviderCred struct {
	Name    string `json:"name"`
	Present bool   `json:"present"`
}

// AgentSummary is the list-row view of a fleet agent. The health/fly_state/url/
// last_deploy fields are enriched from a status snapshot when one is available
// and otherwise stay zero, so listing never requires live network access.
type AgentSummary struct {
	ID                string `json:"id"`
	Model             string `json:"model"`
	FlyApp            string `json:"fly_app"`
	TailscaleHostname string `json:"tailscale_hostname"`
	Vault             string `json:"vault"`
	Lifecycle         string `json:"lifecycle"`
	Health            string `json:"health,omitempty"`
	FlyState          string `json:"fly_state,omitempty"`
	URL               string `json:"url,omitempty"`
	LastDeploy        string `json:"last_deploy,omitempty"`
}

// AgentDetail is the full single-agent view edited by the console.
type AgentDetail struct {
	AgentSummary
	Region               string   `json:"region"`
	Memory               string   `json:"memory"`
	CPUs                 int      `json:"cpus"`
	Runtime              string   `json:"runtime"`
	Network              string   `json:"network"`
	ModelProvider        string   `json:"model_provider"`
	SoulPreview          string   `json:"soul_preview"`
	CompanionSoulEnabled bool     `json:"companion_soul_enabled"`
	VaultConnections     []string `json:"vault_connections"`
}

// AgentInput is the structured payload the UI sends to create or update an
// agent. Omitted optional fields fall back to sensible defaults that mirror
// examples/minimal.
type AgentInput struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Model                string `json:"model"`
	Memory               string `json:"memory"`
	CPUs                 int    `json:"cpus"`
	Region               string `json:"region"`
	TailscaleHostname    string `json:"tailscale_hostname"`
	FlyApp               string `json:"fly_app"`
	Runtime              string `json:"runtime"`
	Network              string `json:"network"`
	ModelProvider        string `json:"model_provider"`
	Lifecycle            string `json:"lifecycle"`
	Soul                 string `json:"soul"`
	CompanionSoulEnabled *bool  `json:"companion_soul_enabled,omitempty"`
	VaultName            string `json:"vault_name"`
}

// PlanChange is one line of a computed plan, redacted to the safe fields the UI
// renders.
type PlanChange struct {
	Kind      string `json:"kind"`
	Action    string `json:"action"`
	Address   string `json:"address"`
	Message   string `json:"message"`
	Protected bool   `json:"protected"`
}

// PlanResponse is the result of POST /api/console/plan. Hash is the sha256 of
// the canonical plan JSON; apply must echo it back to guard against stale plans.
type PlanResponse struct {
	Hash    string       `json:"hash"`
	Text    string       `json:"text"`
	Changes []PlanChange `json:"changes"`
}

// ApplyRequest is the body of POST /api/console/apply.
type ApplyRequest struct {
	Hash string `json:"hash"`
}

// ApplyResponse returns the async operation id to poll.
type ApplyResponse struct {
	OperationID string `json:"operation_id"`
}

// OperationStatus is the polled state of an async apply operation.
type OperationStatus struct {
	ID               string   `json:"id"`
	State            string   `json:"state"`
	StartedAt        string   `json:"started_at,omitempty"`
	FinishedAt       string   `json:"finished_at,omitempty"`
	ChangedResources []string `json:"changed_resources"`
	Error            string   `json:"error,omitempty"`
}

// ApplyHistoryEntry is a past apply row from the state applies table.
type ApplyHistoryEntry struct {
	ID         int64  `json:"id"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at,omitempty"`
	Status     string `json:"status"`
}

// LogsResponse returns recent offline state events for an agent. Live Fly/agent
// task logs are a later Hermes feature.
type LogsResponse struct {
	AgentID string   `json:"agent_id"`
	Lines   []string `json:"lines"`
	Source  string   `json:"source"`
	Note    string   `json:"note"`
}

// Operation is the in-memory record of an async apply tracked by the
// OperationRunner.
type Operation struct {
	ID         string          `json:"id"`
	State      string          `json:"state"`
	StartedAt  time.Time       `json:"started_at"`
	FinishedAt time.Time       `json:"finished_at"`
	Changed    []string        `json:"changed"`
	PlanJSON   json.RawMessage `json:"plan_json,omitempty"`
	Error      string          `json:"error,omitempty"`
}
