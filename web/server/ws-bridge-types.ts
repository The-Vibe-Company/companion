import type { ServerWebSocket } from "bun";
import type {
  BackendType,
  BrowserIncomingMessage,
  McpServerConfig,
  PermissionRequest,
  SessionState,
  BufferedBrowserEvent,
} from "./session-types.js";
import type { IBackendAdapter } from "./backend-adapter.js";
import type { SessionStateMachine } from "./session-state-machine.js";
import { getSettings } from "./settings-manager.js";

export interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

export interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
  subscribed?: boolean;
  lastAckSeq?: number;
}

export interface TerminalSocketData {
  kind: "terminal";
  terminalId: string;
}

export interface NoVncSocketData {
  kind: "novnc";
  sessionId: string;
}

export type SocketData = CLISocketData | BrowserSocketData | TerminalSocketData | NoVncSocketData;

/** Tracks a pending control_request sent to CLI that expects a control_response. */
export interface PendingControlRequest {
  subtype: string;
  resolve: (response: unknown) => void;
}

export interface Session {
  id: string;
  backendType: BackendType;
  /** Unified backend adapter — replaces the former cliSocket (Claude) / codexAdapter (Codex) fields. */
  backendAdapter: IBackendAdapter | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  nextEventSeq: number;
  eventBuffer: BufferedBrowserEvent[];
  lastAckSeq: number;
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
  /** Timestamp of last non-keepalive CLI message (for idle detection) */
  lastCliActivityTs: number;
  /** Formal session state machine tracking phase and validating transitions. */
  stateMachine: SessionStateMachine;
  /** Cleanup function for state machine transition listener — call on session teardown. */
  unsubscribeStateMachine?: () => void;
  /**
   * Per-session in-memory mirror of the dynamic MCP server set the bridge has
   * sent to the backend via `mcp_set_servers`. Bridge-only — NOT persisted to
   * disk (the CLI is relaunched fresh on restart and the dynamic set is lost
   * anyway). Updated in two places:
   *
   *   1. `routeBrowserMessage` when it sees a `mcp_set_servers` flowing from
   *      browsers / programmatic injectors — we apply `deleteKeys` first,
   *      then upsert `servers`. This mirrors what the backend just received.
   *   2. `bindIde` / `unbindIde` after their own `adapter.send` succeeds.
   *
   * Read by `bindIde` / `unbindIde` to derive the Claude merged payload so
   * other user-configured dynamic MCP servers are not silently wiped by
   * the full-replace semantics of Claude's `mcp_set_servers` control_request.
   */
  dynamicMcpServers: Record<string, McpServerConfig>;
  /**
   * Set true during the async window of `bindIde`/`unbindIde` between the
   * pre-bind queue drain and the `applyMcpSetServers` acknowledgement.
   * While set, `routeBrowserMessage` queues incoming `mcp_set_servers`
   * messages instead of forwarding them, preventing a concurrent user
   * payload from clobbering the IDE entry on Claude's full-replace wire.
   */
  ideBindInProgress?: boolean;
}

export type GitSessionKey =
  | "git_branch"
  | "is_worktree"
  | "is_containerized"
  | "repo_root"
  | "git_ahead"
  | "git_behind";

export function makeDefaultState(
  sessionId: string,
  backendType: BackendType = "claude",
): SessionState {
  return {
    session_id: sessionId,
    backend_type: backendType,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    aiValidationEnabled: getSettings().aiValidationEnabled,
    aiValidationAutoApprove: getSettings().aiValidationAutoApprove,
    aiValidationAutoDeny: getSettings().aiValidationAutoDeny,
  };
}
