// Types for the WebSocket bridge between Claude Code CLI and the browser

import type { SessionPhase } from "./session-state-machine.js";

// ─── CLI Message Types (NDJSON from Claude Code CLI) ──────────────────────────

export interface CLISystemInitMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: string;
  apiKeySource: string;
  claude_code_version: string;
  slash_commands: string[];
  agents?: string[];
  skills?: string[];
  output_style: string;
  uuid: string;
}

export interface CLISystemStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
}

export interface CLICompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
  };
  uuid: string;
  session_id: string;
}

export interface CLITaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  uuid: string;
  session_id: string;
}

export interface CLIFilesPersistedMessage {
  type: "system";
  subtype: "files_persisted";
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
  uuid: string;
  session_id: string;
}

export interface CLIHookStartedMessage {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
}

export interface CLIHookProgressMessage {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: string;
  session_id: string;
}

export interface CLIHookResponseMessage {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: "success" | "error" | "cancelled";
  uuid: string;
  session_id: string;
}

export type CLISystemMessage =
  | CLISystemInitMessage
  | CLISystemStatusMessage
  | CLICompactBoundaryMessage
  | CLITaskNotificationMessage
  | CLIFilesPersistedMessage
  | CLIHookStartedMessage
  | CLIHookProgressMessage
  | CLIHookResponseMessage;

export interface CLIAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIResultMessage {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    maxOutputTokens: number;
    costUSD: number;
  }>;
  total_lines_added?: number;
  total_lines_removed?: number;
  uuid: string;
  session_id: string;
}

export interface CLIStreamEventMessage {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export interface CLIToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  uuid: string;
  session_id: string;
}

export interface CLIToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

export interface CLIControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: PermissionUpdate[];
    description?: string;
    tool_use_id: string;
    agent_id?: string;
    title?: string;
    display_name?: string;
    blocked_path?: string;
    decision_reason?: string;
  };
}

export interface CLIKeepAliveMessage {
  type: "keep_alive";
}

export interface CLIAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIControlResponseMessage {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
  };
}

/** CLI echoes user messages back (including subagent tool_result blocks). */
export interface CLIUserEchoMessage {
  type: "user";
  message: { role: string; content: unknown };
  uuid?: string;
  session_id?: string;
}

/** Rate-limit status from Claude API (allowed/throttled). */
export interface CLIRateLimitEventMessage {
  type: "rate_limit_event";
  rate_limit_info: Record<string, unknown>;
  uuid?: string;
}

/** CLI cancels a pending control_request (e.g. permission revoked). */
export interface CLIControlCancelRequestMessage {
  type: "control_cancel_request";
  request_id: string;
}

/** Simplified assistant text (streamlined output mode). @internal */
export interface CLIStreamlinedTextMessage {
  type: "streamlined_text";
  text: string;
  session_id: string;
  uuid: string;
}

/** Simplified tool use summary (e.g. "Read 2 files, wrote 1 file"). @internal */
export interface CLIStreamlinedToolUseSummaryMessage {
  type: "streamlined_tool_use_summary";
  tool_summary: string;
  session_id: string;
  uuid: string;
}

/** Predicted next user prompts (enabled via promptSuggestions in initialize). */
export interface CLIPromptSuggestionMessage {
  type: "prompt_suggestion";
  suggestions: string[];
  session_id: string;
  uuid: string;
}

export type CLIMessage =
  | CLISystemMessage
  | CLIAssistantMessage
  | CLIResultMessage
  | CLIStreamEventMessage
  | CLIToolProgressMessage
  | CLIToolUseSummaryMessage
  | CLIControlRequestMessage
  | CLIControlResponseMessage
  | CLIKeepAliveMessage
  | CLIAuthStatusMessage
  | CLIUserEchoMessage
  | CLIRateLimitEventMessage
  | CLIControlCancelRequestMessage
  | CLIStreamlinedTextMessage
  | CLIStreamlinedToolUseSummaryMessage
  | CLIPromptSuggestionMessage;

// ─── Content Block Types ──────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; budget_tokens?: number };

// ─── Browser Message Types (browser <-> bridge) ──────────────────────────────

/** Messages the browser sends to the bridge */
export type BrowserOutgoingMessage =
  | { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[]; client_msg_id?: string }
  | { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: PermissionUpdate[]; message?: string; client_msg_id?: string }
  | { type: "session_subscribe"; last_seq: number }
  | { type: "session_ack"; last_seq: number }
  | { type: "interrupt"; client_msg_id?: string }
  | { type: "set_model"; model: string; client_msg_id?: string }
  | { type: "set_permission_mode"; mode: string; client_msg_id?: string }
  | { type: "mcp_get_status"; client_msg_id?: string }
  | { type: "mcp_toggle"; serverName: string; enabled: boolean; client_msg_id?: string }
  | { type: "mcp_reconnect"; serverName: string; client_msg_id?: string }
  | {
      type: "mcp_set_servers";
      servers: Record<string, McpServerConfig>;
      /**
       * Explicit per-key removal signal. Used by `unbindIde` to delete a
       * previously-upserted MCP server entry. Needed because Codex's
       * `config/batchWrite` treats `servers: {}` as zero upserts with NO
       * deletions — an empty record can never express "remove this key".
       *
       * Semantics:
       *   - Codex adapter: for each name in `deleteKeys`, issues a
       *     `config/value/write` with `value: null, mergeStrategy: "replace"`
       *     (reusing the pattern at codex-adapter.ts:1478 for invalid-transport
       *     cleanup). Executes BEFORE `servers` upserts so a single
       *     `mcp_set_servers` with both fields is well-defined.
       *   - Claude adapter: IGNORED at the adapter layer. Claude's upstream
       *     `mcp_set_servers` control_request already clears dynamic entries
       *     that aren't present in `servers`, so an empty `servers: {}` is a
       *     full replacement. Stripping `deleteKeys` keeps the wire payload
       *     compliant with the Claude SDK schema.
       */
      deleteKeys?: string[];
      client_msg_id?: string;
    }
  | { type: "set_ai_validation"; aiValidationEnabled?: boolean | null; aiValidationAutoApprove?: boolean | null; aiValidationAutoDeny?: boolean | null; client_msg_id?: string }
  | { type: "end_session"; reason?: string; client_msg_id?: string }
  | { type: "stop_task"; task_id: string; client_msg_id?: string }
  | { type: "update_environment_variables"; variables: Record<string, string>; client_msg_id?: string };

/** Messages the bridge sends to the browser */
export type BrowserIncomingMessageBase =
  | { type: "session_init"; session: SessionState }
  | { type: "session_update"; session: Partial<SessionState> }
  | { type: "assistant"; message: CLIAssistantMessage["message"]; parent_tool_use_id: string | null; timestamp?: number }
  | { type: "stream_event"; event: unknown; parent_tool_use_id: string | null }
  | {
    type: "system_event";
    event:
      | Pick<CLICompactBoundaryMessage, "subtype" | "compact_metadata" | "uuid" | "session_id">
      | Pick<CLITaskNotificationMessage, "subtype" | "task_id" | "status" | "output_file" | "summary" | "uuid" | "session_id">
      | Pick<CLIFilesPersistedMessage, "subtype" | "files" | "failed" | "processed_at" | "uuid" | "session_id">
      | Pick<CLIHookStartedMessage, "subtype" | "hook_id" | "hook_name" | "hook_event" | "uuid" | "session_id">
      | Pick<CLIHookProgressMessage, "subtype" | "hook_id" | "hook_name" | "hook_event" | "stdout" | "stderr" | "output" | "uuid" | "session_id">
      | Pick<CLIHookResponseMessage, "subtype" | "hook_id" | "hook_name" | "hook_event" | "output" | "stdout" | "stderr" | "exit_code" | "outcome" | "uuid" | "session_id">;
    timestamp?: number;
  }
  | { type: "result"; data: CLIResultMessage }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | { type: "permission_auto_resolved"; request: PermissionRequest; behavior: "allow" | "deny"; reason: string }
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; elapsed_time_seconds: number }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | { type: "status_change"; status: "compacting" | "idle" | "running" | null }
  | { type: "auth_status"; isAuthenticating: boolean; output: string[]; error?: string }
  | { type: "error"; message: string }
  | { type: "cli_disconnected" }
  | { type: "cli_connected" }
  | { type: "user_message"; content: string; timestamp: number; id?: string }
  | { type: "message_history"; messages: BrowserIncomingMessage[] }
  | { type: "event_replay"; events: BufferedBrowserEvent[] }
  | { type: "session_name_update"; name: string }
  | { type: "pr_status_update"; pr: import("./github-pr.js").GitHubPRInfo | null; available: boolean }
  | { type: "mcp_status"; servers: McpServerDetail[] }
  | { type: "session_phase"; phase: SessionPhase; previousPhase: SessionPhase }
  | { type: "prompt_suggestion"; suggestions: string[] }
  | { type: "streamlined_text"; text: string }
  | { type: "streamlined_tool_use_summary"; tool_summary: string }
  // Broadcast to all browsers when the available-IDE list changes (add/remove/update).
  // IdePicker instances refetch `GET /api/ide/available` on receipt.
  //
  // `generation` is a monotonic counter sourced from ide-discovery's
  // `scanGeneration`. The client uses it to deduplicate fan-out across
  // multiple session sockets receiving the same server broadcast: the same
  // generation means the same underlying discovery scan. A newer generation
  // is always a fresh event — including legitimate fast add+remove cycles
  // (e.g. IDE restart) that would be lost under a time-window dedupe.
  | { type: "ide_list_changed"; generation?: number };

export type BrowserIncomingMessage = BrowserIncomingMessageBase & { seq?: number };

export type ReplayableBrowserIncomingMessage = Exclude<BrowserIncomingMessageBase, { type: "event_replay" }>;

export interface BufferedBrowserEvent {
  seq: number;
  message: ReplayableBrowserIncomingMessage;
}

// ─── Session State ────────────────────────────────────────────────────────────

export type BackendType = "claude" | "codex";

/**
 * Binding between a Companion session and a running IDE (via ~/.claude/ide/ lockfile).
 *
 * Tri-state semantics on `SessionState.ideBinding`:
 *   - `undefined` — never set (e.g. Codex session or freshly created Claude session)
 *   - `null`      — explicitly unbound (BIND-04: lockfile disappeared, FE detects transition)
 *   - `IdeBinding` — active binding
 *
 * `authToken` is present at runtime but NEVER persisted to disk (see Task 8 /
 * session-store.ts). It is re-read from the lockfile on next bind operation.
 */
export interface IdeBinding {
  /** TCP port from lockfile filename or inside JSON. */
  port: number;
  /** Human-readable IDE name, e.g. "Neovim", "Visual Studio Code". */
  ideName: string;
  /** Absolute workspace roots reported by the IDE. */
  workspaceFolders: string[];
  /** Transport advertised in the lockfile. */
  transport: "ws-ide" | "sse-ide";
  /** Auth token from lockfile — runtime only, never persisted. */
  authToken?: string;
  /** Epoch milliseconds when the binding was established. */
  boundAt: number;
  /** Absolute path to the source `.lock` file. */
  lockfilePath: string;
}

export interface SessionState {
  session_id: string;
  backend_type?: BackendType;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents: string[];
  slash_commands: string[];
  skills: string[];
  total_cost_usd: number;
  num_turns: number;
  context_used_percent: number;
  is_compacting: boolean;
  git_branch: string;
  is_worktree: boolean;
  is_containerized: boolean;
  repo_root: string;
  git_ahead: number;
  git_behind: number;
  total_lines_added: number;
  total_lines_removed: number;
  // Codex-specific token details (forwarded from thread/tokenUsage/updated)
  codex_token_details?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    modelContextWindow: number;
  };
  // Codex-specific rate limits (forwarded from account/rateLimits/updated)
  codex_rate_limits?: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  };
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** If this session was spawned by an agent */
  agentId?: string;
  /** Human-readable name of the agent that spawned this session */
  agentName?: string;
  /** Per-session AI validation override. null/undefined = use global default */
  aiValidationEnabled?: boolean | null;
  /** Per-session auto-approve override. null/undefined = use global default */
  aiValidationAutoApprove?: boolean | null;
  /** Per-session auto-deny override. null/undefined = use global default */
  aiValidationAutoDeny?: boolean | null;
  /** If this session is linked to a Linear agent session */
  linearSessionId?: string;
  /**
   * Active IDE binding, or explicit-unbind state. See `IdeBinding` docstring
   * for the tri-state semantics (undefined vs null vs object).
   */
  ideBinding?: IdeBinding | null;
}

// ─── MCP Types ───────────────────────────────────────────────────────────────

export interface McpServerConfig {
  type: "stdio" | "sse" | "http" | "sdk";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpServerDetail {
  name: string;
  status: "connected" | "failed" | "disabled" | "connecting";
  serverInfo?: unknown;
  error?: string;
  config: { type: string; url?: string; command?: string; args?: string[] };
  scope: string;
  tools?: { name: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } }[];
}

// ─── Permission Request ──────────────────────────────────────────────────────

// ─── Permission Rule Types ───────────────────────────────────────────────────

export type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

export type PermissionUpdate =
  | { type: "addRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "replaceRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "removeRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "setMode"; mode: string; destination: PermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionDestination };

export interface AiValidationInfo {
  verdict: "safe" | "dangerous" | "uncertain";
  reason: string;
  ruleBasedOnly: boolean;
}

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  description?: string;
  tool_use_id: string;
  agent_id?: string;
  title?: string;
  display_name?: string;
  blocked_path?: string;
  decision_reason?: string;
  timestamp: number;
  ai_validation?: AiValidationInfo;
}

// ─── Session Creation Progress (SSE streaming) ──────────────────────────────

export type CreationStepId =
  | "resolving_env"
  | "fetching_git"
  | "checkout_branch"
  | "pulling_git"
  | "creating_worktree"
  | "pulling_image"
  | "building_image"
  | "creating_container"
  | "copying_workspace"
  | "running_init_script"
  | "launching_cli";

export interface CreationProgressEvent {
  step: CreationStepId;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}
