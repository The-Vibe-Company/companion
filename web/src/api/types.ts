/**
 * TypeScript DTOs for the Companion Console JSON API.
 *
 * These interfaces mirror the Go structs in `internal/console/types.go` and
 * `internal/status/status.go`. JSON is snake_case on the wire, so the field
 * names here are deliberately snake_case to match the server exactly — do not
 * camelCase them. Security note: provider credentials are name + presence only;
 * a secret value never crosses this boundary.
 */

/** A redacted provider credential: env var name + whether it is present. */
export interface ProviderCred {
  name: string;
  present: boolean;
}

/** Workspace summary for the console header / settings view. */
export interface WorkspaceInfo {
  name: string;
  root: string;
  agent_count: number;
  providers: ProviderCred[];
}

/**
 * List-row view of a fleet agent. The health/fly_state/url/last_deploy fields
 * are enriched from a live status snapshot when one is available and are
 * otherwise absent, so listing never requires network access.
 */
export interface AgentSummary {
  id: string;
  model: string;
  fly_app: string;
  tailscale_hostname: string;
  vault: string;
  lifecycle: string;
  health?: string;
  fly_state?: string;
  url?: string;
  last_deploy?: string;
}

/** Full single-agent view edited by the console. */
export interface AgentDetail extends AgentSummary {
  region: string;
  memory: string;
  cpus: number;
  runtime: string;
  network: string;
  model_provider: string;
  soul_preview: string;
  companion_soul_enabled: boolean;
  vault_connections: string[];
}

/**
 * Structured payload the UI sends to create or update an agent. Omitted
 * optional fields fall back to server-side defaults that mirror
 * examples/minimal.
 */
export interface AgentInput {
  id: string;
  name: string;
  model: string;
  memory: string;
  cpus: number;
  region: string;
  tailscale_hostname: string;
  fly_app: string;
  runtime: string;
  network: string;
  model_provider: string;
  lifecycle: string;
  soul: string;
  companion_soul_enabled: boolean;
  vault_name: string;
}

/** Plan change kinds, mirroring the engine's single-character markers. */
export type PlanChangeKind = "+" | "~" | "-" | "=" | "!";

/** One line of a computed plan, redacted to the safe fields the UI renders. */
export interface PlanChange {
  kind: PlanChangeKind | string;
  action: string;
  address: string;
  message: string;
  protected: boolean;
}

/** Result of POST /api/console/plan. `hash` must be echoed back to apply. */
export interface PlanResponse {
  hash: string;
  text: string;
  changes: PlanChange[];
}

/** Body of POST /api/console/apply. */
export interface ApplyRequest {
  hash: string;
}

/** Response of POST /api/console/apply: the async operation id to poll. */
export interface ApplyResponse {
  operation_id: string;
}

/** Terminal and in-flight states of an async apply operation. */
export type OperationState = "pending" | "running" | "succeeded" | "failed";

/** Polled state of an async apply operation. */
export interface OperationStatus {
  id: string;
  state: OperationState | string;
  started_at?: string;
  finished_at?: string;
  changed_resources: string[];
  error?: string;
}

/** A past apply row from the state applies table. */
export interface ApplyHistoryEntry {
  id: number;
  started_at: string;
  finished_at?: string;
  status: string;
}

/** Recent offline state events for an agent. */
export interface LogsResponse {
  agent_id: string;
  lines: string[];
  source: string;
  note: string;
}

/** Live status of a single fleet service (from the status poller). */
export interface ServiceStatus {
  id: string;
  kind: string;
  fly_app?: string;
  host?: string;
  url?: string;
  health: string;
  http_status?: number;
  online: boolean;
  machine_state?: string;
  model?: string;
  vault?: string;
  error?: string;
}

/** Roll-up of service health for the status header. */
export interface StatusSummary {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
}

/** One full poll of the fleet (existing /api/status contract). */
export interface StatusSnapshot {
  workspace: string;
  generated_at: string;
  services: ServiceStatus[];
  drift_count: number;
  summary: StatusSummary;
}
