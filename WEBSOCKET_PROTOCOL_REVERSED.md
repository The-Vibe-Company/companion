# Claude Code WebSocket SDK Protocol — Reverse Engineered

> **Reverse-engineered from Claude Code CLI v2.1.37 (`cli.js`) and Agent SDK v0.2.37 (`sdk.mjs`, `sdk.d.ts`)**
> **Updated with v2.1.81 discoveries (channels system, new message types, enriched fields)**
>
> This document describes the undocumented WebSocket protocol that Claude Code CLI uses for programmatic control via the `--sdk-url` flag. This is the same NDJSON protocol used over stdin/stdout, but transported over WebSocket — enabling full bidirectional control without tmux or PTY hacks.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Launching Claude Code in WebSocket Mode](#2-launching-claude-code-in-websocket-mode)
3. [Transport Architecture](#3-transport-architecture)
4. [Connection Lifecycle](#4-connection-lifecycle)
5. [Wire Protocol (NDJSON)](#5-wire-protocol-ndjson)
6. [Message Types — Complete Reference](#6-message-types--complete-reference)
7. [Control Protocol (19 Subtypes)](#7-control-protocol-19-subtypes)
8. [Permission / Tool Approval Flow](#8-permission--tool-approval-flow)
9. [Session Management](#9-session-management)
10. [Reconnection & Resilience](#10-reconnection--resilience)
11. [Environment Variables](#11-environment-variables)
12. [Transport Class Hierarchy](#12-transport-class-hierarchy)
13. [Implementation Guide](#13-implementation-guide)
14. [MCP Channels (Codename: "tengu harbor")](#14-mcp-channels-codename-tengu-harbor)

---

## 1. Overview

Claude Code CLI has a **hidden** `--sdk-url <ws-url>` flag (`.hideHelp()` in Commander) that makes the CLI act as a **WebSocket client**, connecting to a server you control. The protocol is **NDJSON** (newline-delimited JSON) — the same format used over stdin/stdout by the official `@anthropic-ai/claude-agent-sdk`.

### Why This Matters

- **No SDK dependency**: The `--sdk-url` flag is baked into the CLI binary itself
- **Uses your Claude Code subscription**: No API billing, uses your existing plan
- **Full programmatic control**: Send prompts, approve/deny permissions, interrupt execution
- **Replaces tmux hacks**: Clean WebSocket channel instead of PTY automation
- **Same protocol as Claude Code Web**: The web UI uses the same NDJSON-over-WebSocket approach

### Key Characteristics

| Property | Value |
|----------|-------|
| Transport | WebSocket (`ws://` or `wss://`) |
| Protocol | NDJSON (one JSON object per `\n`-terminated line) |
| Direction | CLI connects TO your server (CLI = client) |
| Auth | `Authorization: Bearer <token>` header on upgrade |
| First message | Server sends `user` message, CLI responds with `system/init` |
| Keepalive | `keep_alive` messages + WebSocket ping/pong every 10s |

---

## 2. Launching Claude Code in WebSocket Mode

### Basic Command

```bash
claude --sdk-url ws://localhost:8765 \
       --print \
       --output-format stream-json \
       --input-format stream-json \
       --verbose \
       -p "placeholder"
```

### Required Flags

| Flag | Required | Purpose |
|------|----------|---------|
| `--sdk-url <url>` | Yes | WebSocket URL to connect to |
| `--print` (`-p`) | Yes | Enables headless/non-interactive mode |
| `--output-format stream-json` | Yes | NDJSON output (validated by CLI) |
| `--input-format stream-json` | Yes | NDJSON input (validated by CLI) |

### Useful Optional Flags

| Flag | Purpose |
|------|---------|
| `--verbose` | Include `stream_event` messages (token-by-token streaming) |
| `--model <model>` | Override model (e.g., `claude-opus-4-6`) |
| `--permission-mode <mode>` | Set initial permission mode |
| `--allowedTools <tools>` | Auto-approve specific tools |
| `--resume <session-id>` | Resume a previous session |
| `--continue` | Continue the most recent session |
| `--max-turns <n>` | Limit conversation turns |

### Notes

- The `-p "placeholder"` prompt argument is **ignored** when `--sdk-url` is used — the CLI waits for a `user` message over WebSocket instead
- Both `--input-format` and `--output-format` must be `stream-json` (CLI exits with error otherwise)
- The CLI will wait indefinitely for the first `user` message after connecting

---

## 3. Transport Architecture

Six transport classes were deobfuscated from the minified CLI:

```
                           ┌─────────────────────┐
                           │  ad1 (ProcessInput)  │  Base: NDJSON parser + control request/response
                           │  - read() generator  │
                           │  - sendRequest()     │
                           │  - createCanUseTool() │
                           └──────────┬──────────┘
                                      │ extends
                           ┌──────────▼──────────┐
                           │  LQA (SdkUrl)        │  --sdk-url mode  ← OUR TARGET
                           │  - PassThrough bridge │
                           │  - transport delegate │
                           └──────────┬──────────┘
                                      │ uses
                    ┌─────────────────┼─────────────────┐
                    │                                     │
          ┌─────────▼─────────┐              ┌───────────▼───────────┐
          │  sd1 (WebSocket)   │              │  kQA (Hybrid)          │
          │  - WS send+receive │              │  extends sd1           │
          │  - reconnect logic │              │  - WS receive only     │
          │  - message buffer  │              │  - HTTP POST for send  │
          │  - ping/pong       │              │  - retry with backoff  │
          └────────────────────┘              └────────────────────────┘

  Web UI / Remote Sessions:
          ┌────────────────────┐         ┌─────────────────────────┐
          │  MFA (SessionsWS)  │◄────────│  WFA (RemoteSessionMgr) │
          │  - Subscribe WS    │         │  - Permission routing   │
          │  - API auth        │         │  - HTTP POST for send   │
          └────────────────────┘         └─────────────────────────┘

  Direct Connect (Browser):
          ┌────────────────────┐
          │  fFA (DirectConnect)│  Simplified WS for browser use
          │  - sendMessage()   │
          │  - respondToPermit │
          │  - sendInterrupt() │
          └────────────────────┘
```

### Transport Selection Logic

```typescript
function createTransport(url: URL, headers?: Record<string, string>, sessionId?: string) {
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    if (process.env.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2) {
      return new HybridTransport(url, headers, sessionId);  // WS receive + HTTP POST send
    }
    return new WebSocketTransport(url, headers, sessionId);  // Pure WebSocket
  }
  throw Error(`Unsupported protocol: ${url.protocol}`);
}
```

---

## 4. Connection Lifecycle

### Sequence Diagram

```
  Your Server (WS)                          Claude Code CLI
       │                                         │
       │◄──────── WebSocket CONNECT ──────────────│  (with Auth header)
       │                                         │
       │                                         │──► system/init message
       │◄──────── {"type":"system","subtype":"init",...} ──│
       │                                         │
       │──── {"type":"user","message":{...}} ────►│  (you send first prompt)
       │                                         │
       │                                         │──► LLM processing...
       │                                         │
       │◄──── {"type":"stream_event",...} ────────│  (if --verbose)
       │◄──── {"type":"stream_event",...} ────────│
       │◄──── {"type":"assistant",...} ───────────│  (full response)
       │                                         │
       │  (if tool needs permission)              │
       │◄──── {"type":"control_request",          │
       │       "request":{"subtype":"can_use_tool"│
       │       ,"tool_name":"Bash",...}} ─────────│
       │                                         │
       │──── {"type":"control_response",          │  (you approve/deny)
       │      "response":{"subtype":"success",    │
       │      "request_id":"...","response":      │
       │      {"behavior":"allow",...}}} ─────────►│
       │                                         │
       │◄──── {"type":"assistant",...} ───────────│  (continues after approval)
       │◄──── {"type":"result",...} ──────────────│  (query complete)
       │                                         │
       │──── {"type":"user","message":{...}} ────►│  (next turn, optional)
       │         ...                              │
```

### Authentication

The CLI sends authentication via HTTP headers on the WebSocket upgrade request:

```
Authorization: Bearer <session_access_token>
X-Environment-Runner-Version: <version>  (optional)
X-Last-Request-Id: <uuid>  (on reconnect, for message replay)
```

**Token sources** (priority order):
1. `CLAUDE_CODE_SESSION_ACCESS_TOKEN` environment variable
2. Internal session ingress token
3. Token read from file descriptor specified by `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR`

---

## 5. Wire Protocol (NDJSON)

Each message is a single JSON object followed by `\n` (newline). Multiple messages can be sent in sequence.

```
{"type":"user","message":{"role":"user","content":"Hello"},"parent_tool_use_id":null,"session_id":""}\n
{"type":"assistant","message":{...},"session_id":"abc123","uuid":"..."}\n
```

### Message Categories

| Direction | Types |
|-----------|-------|
| **Server → CLI** | `user`, `control_response`, `control_cancel_request`, `keep_alive`, `update_environment_variables` |
| **CLI → Server** | `system`, `assistant`, `result`, `stream_event`, `tool_progress`, `tool_use_summary`, `auth_status`, `control_request` (can_use_tool, hook_callback), `control_cancel_request`, `keep_alive`, `rate_limit_event`, `streamlined_text`, `streamlined_tool_use_summary`, `prompt_suggestion` |
| **Bidirectional** | `control_request`, `control_response`, `keep_alive` |

### Filtered by SDK (present on wire but not exposed to consumers)

These types are present in the NDJSON stream but the official SDK filters them out:
- `control_request` / `control_response` / `control_cancel_request` — handled internally
- `keep_alive` — silently consumed
- `streamlined_text` / `streamlined_tool_use_summary` — internal streamlined mode

---

## 6. Message Types — Complete Reference

### 6.1. `user` — User Message (Server → CLI)

Send a prompt or follow-up message to the Claude Code agent.

```typescript
interface SDKUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];  // string for simple text, array for structured
  };
  parent_tool_use_id: string | null;   // null for top-level, string for sub-agent
  session_id: string;                  // "" for first message, then use session_id from init
  uuid?: string;                       // optional
  isSynthetic?: boolean;               // true for internally-generated messages
}
```

**Example — Simple text prompt:**
```json
{
  "type": "user",
  "message": { "role": "user", "content": "What files are in this project?" },
  "parent_tool_use_id": null,
  "session_id": ""
}
```

### 6.2. `system/init` — Initialization (CLI → Server)

First message sent by the CLI after WebSocket connection. Contains full capability info.

```typescript
interface SDKSystemMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];                     // ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", ...]
  mcp_servers: { name: string; status: string }[];
  model: string;                       // "claude-sonnet-4-6"
  permissionMode: PermissionMode;
  apiKeySource: string;
  claude_code_version: string;         // "2.1.37"
  slash_commands: string[];
  agents?: string[];
  skills?: string[];
  plugins?: { name: string; path: string }[];
  output_style: string;
  uuid: string;
  session_id: string;
}
```

### 6.3. `assistant` — LLM Response (CLI → Server)

Full assistant message after LLM completes a response.

```typescript
interface SDKAssistantMessage {
  type: "assistant";
  message: {
    id: string;                        // "msg_01..."
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];           // text blocks, tool_use blocks, thinking blocks
    stop_reason: string | null;        // "end_turn", "tool_use", etc.
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown";
  uuid: string;
  session_id: string;
}
```

### 6.4. `stream_event` — Streaming Chunks (CLI → Server)

Token-by-token streaming events. Only sent when `--verbose` flag is used.

```typescript
interface SDKPartialAssistantMessage {
  type: "stream_event";
  event: BetaRawMessageStreamEvent;    // Anthropic streaming event
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}
```

### 6.5. `result` — Query Complete (CLI → Server)

Sent when the query finishes (success or error).

```typescript
// Success
interface SDKResultSuccess {
  type: "result";
  subtype: "success";
  is_error: false;
  result: string;                      // final text result
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
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUSD: number;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
  permission_denials: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[];
  structured_output?: unknown;
  uuid: string;
  session_id: string;
}

// Error
interface SDKResultError {
  type: "result";
  subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  is_error: true;
  errors: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  uuid: string;
  session_id: string;
}
```

### 6.6. `system/status` — Status Change (CLI → Server)

```typescript
interface SDKStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | null;         // null = compacting ended
  permissionMode?: PermissionMode;     // included when mode changes
  uuid: string;
  session_id: string;
}
```

### 6.7. `system/compact_boundary` — Post-Compaction (CLI → Server)

```typescript
interface SDKCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
  };
  uuid: string;
  session_id: string;
}
```

### 6.8. `tool_progress` — Tool Execution Heartbeat (CLI → Server)

```typescript
interface SDKToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  uuid: string;
  session_id: string;
}
```

### 6.9. `tool_use_summary` — Tool Execution Summary (CLI → Server)

```typescript
interface SDKToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}
```

### 6.10. `auth_status` — Authentication Flow (CLI → Server)

```typescript
interface SDKAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}
```

### 6.11. `system/task_notification` — Sub-Agent Task Done (CLI → Server)

```typescript
interface SDKTaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  uuid: string;
  session_id: string;
}
```

### 6.12. `system/files_persisted` — Files Uploaded (CLI → Server)

```typescript
interface SDKFilesPersistedEvent {
  type: "system";
  subtype: "files_persisted";
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
  uuid: string;
  session_id: string;
}
```

### 6.13. Hook Lifecycle Messages (CLI → Server)

```typescript
interface SDKHookStartedMessage {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
}

interface SDKHookProgressMessage {
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

interface SDKHookResponseMessage {
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
```

### 6.14. Transport-Internal Messages

```typescript
// Keep-alive (bidirectional)
interface SDKKeepAliveMessage {
  type: "keep_alive";
}

// Streamlined text (CLI → Server, filtered by SDK)
interface SDKStreamlinedTextMessage {
  type: "streamlined_text";
  text: string;
  session_id: string;
  uuid: string;
}

// Streamlined tool use summary (CLI → Server, filtered by SDK)
interface SDKStreamlinedToolUseSummaryMessage {
  type: "streamlined_tool_use_summary";
  tool_summary: string;
  session_id: string;
  uuid: string;
}

// Update environment variables (Server → CLI)
interface UpdateEnvironmentVariables {
  type: "update_environment_variables";
  variables: Record<string, string>;
}
```

### 6.15. `control_cancel_request` — Cancel Pending Permission (Server → CLI / CLI → Server)

> Added in v2.1.81.

Cancels a pending `control_request`. When the CLI sends this, the server should remove the corresponding pending permission and notify browsers.

```typescript
interface SDKControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;  // matches the request_id of a pending control_request
}
```

### 6.16. `streamlined_text` — Simplified Assistant Output (CLI → Server)

> Added in v2.1.81. Marked `@internal` in the SDK.

Sent when streamlined output mode is active. Provides simplified text output from the assistant without full message structure.

```typescript
interface SDKStreamlinedText {
  type: "streamlined_text";
  text: string;
  session_id: string;
  uuid: string;
}
```

### 6.17. `streamlined_tool_use_summary` — Streamlined Tool Summary (CLI → Server)

> Added in v2.1.81. Marked `@internal` in the SDK.

```typescript
interface SDKStreamlinedToolUseSummary {
  type: "streamlined_tool_use_summary";
  tool_summary: string;  // e.g. "Read 2 files, wrote 1 file"
  session_id: string;
  uuid: string;
}
```

### 6.18. `prompt_suggestion` — Suggested Follow-ups (CLI → Server)

> Added in v2.1.81.

Predicted next user prompts. Enabled by setting `promptSuggestions: true` in the `initialize` control_request.

```typescript
interface SDKPromptSuggestion {
  type: "prompt_suggestion";
  suggestions: string[];
  session_id: string;
  uuid: string;
}
```

### 6.19. `update_environment_variables` — Runtime Env Update (Server → CLI)

> Added in v2.1.81.

Updates environment variables at runtime (e.g., rotating access tokens). This is a direct message type, NOT a control_request.

```typescript
interface SDKUpdateEnvironmentVariables {
  type: "update_environment_variables";
  variables: Record<string, string>;
}
```

---

## 7. Control Protocol (19 Subtypes)

Control messages use a request/response pattern with correlated `request_id` fields.

### Envelope Format

```typescript
// Request
interface SDKControlRequest {
  type: "control_request";
  request_id: string;              // UUID for correlation
  request: ControlRequestPayload;  // discriminated by "subtype"
}

// Success Response
interface SDKControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;            // matches the request
    response?: Record<string, unknown>;
  };
}

// Error Response
interface SDKControlErrorResponse {
  type: "control_response";
  response: {
    subtype: "error";
    request_id: string;
    error: string;
    pending_permission_requests?: SDKControlRequest[];  // queued permissions
  };
}

// Cancel Request
interface SDKControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;              // request to cancel
}
```

### 7.1. `initialize` (Server → CLI)

Register hooks, MCP servers, agents, system prompt. **Must be sent before the first `user` message**.

```typescript
// Request
{
  subtype: "initialize",
  hooks?: Record<HookEvent, { matcher?: string; hookCallbackIds: string[]; timeout?: number }[]>,
  sdkMcpServers?: string[],
  jsonSchema?: Record<string, unknown>,
  systemPrompt?: string,
  appendSystemPrompt?: string,
  agents?: Record<string, AgentDefinition>,
  // NEW in v2.1.81:
  promptSuggestions?: boolean,        // Enable prompt_suggestion messages
  agentProgressSummaries?: boolean,   // Enable agent progress summaries
}

In v2.1.81, the wire format was broadened for some fields (`hooks`, `sdkMcpServers`, `agents`), but the exact extended shapes are not yet fully documented here.

// Response
{
  commands: { name: string; description: string; argumentHint?: string }[],
  output_style: string,
  available_output_styles: string[],
  models: { value: string; displayName: string; description: string }[],
  account: { email?: string; organization?: string; subscriptionType?: string; apiKeySource?: string },
  fast_mode?: boolean,
  // NEW in v2.1.81:
  agents?: Record<string, unknown>,
  pid?: number,
  fast_mode_state?: unknown,
}
```

**Error**: `"Already initialized"` if called twice.

### 7.2. `can_use_tool` (CLI → Server)

**The most important control message.** The CLI asks the server for permission to use a tool.

```typescript
// Request (from CLI)
{
  subtype: "can_use_tool",
  tool_name: string,                    // "Bash", "Edit", "Write", "Read", etc.
  input: Record<string, unknown>,       // tool arguments
  permission_suggestions?: PermissionUpdate[],
  blocked_path?: string,
  decision_reason?: string,             // "hook"|"asyncAgent"|"sandboxOverride"|"classifier"|"workingDir"|"other"
  tool_use_id: string,
  agent_id?: string,
  description?: string,
  // NEW in v2.1.81:
  title?: string,                       // Human-readable title for the permission request
  display_name?: string,                // Display name override for the tool
}

// Response: Allow
{
  behavior: "allow",
  updatedInput: Record<string, unknown>,  // REQUIRED — can modify tool args
  updatedPermissions?: PermissionUpdate[], // save rules for future
  toolUseID?: string
}

// Response: Deny
{
  behavior: "deny",
  message: string,
  interrupt?: boolean,                    // true = abort entire session
  toolUseID?: string
}
```

### 7.3. `interrupt` (Server → CLI)

Abort the current agent turn.

```typescript
// Request
{ subtype: "interrupt" }

// Response: empty success
```

### 7.4. `set_permission_mode` (Server → CLI)

```typescript
// Request
{ subtype: "set_permission_mode", mode: PermissionMode }

// Response
{ mode: PermissionMode }
```

**Error**: `"Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration"`

### 7.5. `set_model` (Server → CLI)

```typescript
// Request
{ subtype: "set_model", model?: string }  // "default" to reset

// Response: empty success
```

### 7.6. `set_max_thinking_tokens` (Server → CLI)

```typescript
// Request
{ subtype: "set_max_thinking_tokens", max_thinking_tokens: number | null }

// Response: empty success
```

### 7.7. `mcp_status` (Server → CLI)

```typescript
// Request
{ subtype: "mcp_status" }

// Response
{
  mcpServers: {
    name: string,
    status: "connected" | "failed" | "disabled" | "connecting",
    serverInfo?: any,
    error?: string,
    config: { type: string; url?: string; command?: string; args?: string[] },
    scope: string,
    tools?: { name: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } }[]
  }[]
}
```

### 7.8. `mcp_message` (Bidirectional)

Route JSON-RPC messages to/from MCP servers.

```typescript
// Request
{ subtype: "mcp_message", server_name: string, message: JSONRPCMessage }

// Response: empty success (or { mcp_response: ... } from SDK side)
```

### 7.9. `mcp_reconnect` (Server → CLI)

```typescript
{ subtype: "mcp_reconnect", serverName: string }
```

### 7.10. `mcp_toggle` (Server → CLI)

```typescript
{ subtype: "mcp_toggle", serverName: string, enabled: boolean }
```

### 7.11. `mcp_set_servers` (Server → CLI)

```typescript
{
  subtype: "mcp_set_servers",
  servers: Record<string, {
    type: "stdio" | "sse" | "http" | "sdk",
    command?: string,
    args?: string[],
    env?: Record<string, string>,
    url?: string
  }>
}
```

### 7.12. `rewind_files` (Server → CLI)

```typescript
// Request
{ subtype: "rewind_files", user_message_id: string, dry_run?: boolean }

// Response (success)
{ canRewind: true, filesChanged?: number, insertions?: number, deletions?: number }
```

### 7.13. `hook_callback` (CLI → Server)

The CLI invokes a registered hook callback.

```typescript
// Request (from CLI)
{
  subtype: "hook_callback",
  callback_id: string,
  input: HookInput,
  tool_use_id?: string
}

// Sync response
{
  continue?: boolean,
  suppressOutput?: boolean,
  stopReason?: string,
  decision?: "approve" | "block",
  reason?: string,
  systemMessage?: string,
  hookSpecificOutput?: {
    hookEventName: "PreToolUse" | "PostToolUse" | "PermissionRequest",
    permissionDecision?: "allow" | "deny" | "ask",
    permissionDecisionReason?: string,
    updatedInput?: Record<string, unknown>,
    additionalContext?: string,
    decision?: { behavior: "allow" | "deny", ... }
  }
}

// Async response
{ async: true, asyncTimeout?: number }
```

### 7.14. `end_session` (Server → CLI)

> Added in v2.1.81.

Gracefully terminate the session.

```typescript
// Request
{
  subtype: "end_session",
  reason?: string
}

// Response: empty success
```

### 7.15. `stop_task` (Server → CLI)

> Added in v2.1.81.

Stop a running sub-agent task.

```typescript
// Request
{
  subtype: "stop_task",
  task_id: string
}

// Response: empty success
```

### 7.16. `cancel_async_message` (Server → CLI)

> Added in v2.1.81.

Cancel an asynchronous message in progress.

```typescript
// Request
{
  subtype: "cancel_async_message",
  uuid: string
}

// Response: empty success
```

### 7.17. `apply_flag_settings` (Server → CLI)

> Added in v2.1.81.

Apply runtime flag/settings changes.

```typescript
// Request
{
  subtype: "apply_flag_settings",
  settings: Record<string, unknown>
}

// Response: empty success
```

### 7.18. `get_settings` (Server → CLI)

> Added in v2.1.81.

Retrieve the effective merged settings and per-source settings.

```typescript
// Request
{
  subtype: "get_settings"
}

// Response
{
  settings: Record<string, unknown>,   // effective merged settings
  sources?: Record<string, unknown>    // per-source settings breakdown
}
```

### 7.19. `elicitation` (CLI → Server)

> Added in v2.1.81.

MCP server elicitation — requests user input via forms or URL redirect.

```typescript
// Request (from CLI)
{
  subtype: "elicitation",
  mode: "form" | "url",
  // form mode: schema-driven input fields
  // url mode: redirect to URL for input
}

// Response: form data or URL redirect result
```

### Direction Summary

| Subtype | Direction | Purpose |
|---------|-----------|---------|
| `initialize` | Server → CLI | Setup hooks, MCP, agents |
| `can_use_tool` | CLI → Server | Permission request |
| `interrupt` | Server → CLI | Abort current turn |
| `set_permission_mode` | Server → CLI | Change mode at runtime |
| `set_model` | Server → CLI | Change model at runtime |
| `set_max_thinking_tokens` | Server → CLI | Change thinking budget |
| `mcp_status` | Server → CLI | Get MCP server statuses |
| `mcp_message` | Bidirectional | Route JSON-RPC messages |
| `mcp_reconnect` | Server → CLI | Reconnect MCP server |
| `mcp_toggle` | Server → CLI | Enable/disable MCP server |
| `mcp_set_servers` | Server → CLI | Configure MCP servers |
| `rewind_files` | Server → CLI | Rewind files to checkpoint |
| `hook_callback` | CLI → Server | Invoke registered hook |
| `end_session` | Server → CLI | Gracefully terminate session |
| `stop_task` | Server → CLI | Stop a running sub-agent task |
| `cancel_async_message` | Server → CLI | Cancel async message in progress |
| `apply_flag_settings` | Server → CLI | Apply runtime flag/settings |
| `get_settings` | Server → CLI | Retrieve effective settings |
| `elicitation` | CLI → Server | MCP server elicitation (form/URL) |

---

## 8. Permission / Tool Approval Flow

### Three-Layer Decision Pipeline

The CLI evaluates permissions through three layers before sending a `can_use_tool` over the wire:

```
Tool Use Request
  │
  ├─► Layer 1: PreToolUse Hooks (local shell scripts)
  │     ├─ allow → tool executes
  │     ├─ deny → tool blocked
  │     └─ ask → fall through
  │
  ├─► Layer 2: Local Rule Evaluation (R5z)
  │     ├─ Check deny rules → if match → DENIED
  │     ├─ Check ask rules → if match → behavior="ask"
  │     ├─ Check mode:
  │     │   bypassPermissions → ALLOWED (never reaches wire)
  │     │   dontAsk → DENIED (never reaches wire)
  │     ├─ Check allow rules (incl. --allowedTools) → ALLOWED
  │     └─ Default → behavior="ask"
  │
  └─► Layer 3: Remote Prompt (WebSocket)
        └─ Sends control_request { subtype: "can_use_tool", ... }
           ├─ Response: { behavior: "allow", updatedInput: {...} } → EXECUTE
           └─ Response: { behavior: "deny", message: "..." } → BLOCKED
```

### `updatedInput` — Modifying Tool Arguments

When responding with `{ behavior: "allow" }`, you **must** include `updatedInput`. This replaces the tool's input entirely. You can:
- Pass through unchanged: `updatedInput: original_input`
- Sanitize commands: Change `rm -rf /` to `echo "blocked"`
- Modify paths: Restrict file access

### `updatedPermissions` — Learning Rules

Return `updatedPermissions` to save rules for the session or settings:

```typescript
type PermissionUpdate =
  | { type: "addRules", rules: { toolName: string, ruleContent?: string }[], behavior: "allow"|"deny"|"ask", destination: PermissionDestination }
  | { type: "replaceRules", rules: [...], behavior: "...", destination: "..." }
  | { type: "removeRules", rules: [...], behavior: "...", destination: "..." }
  | { type: "setMode", mode: PermissionMode, destination: PermissionDestination }
  | { type: "addDirectories", directories: string[], destination: PermissionDestination }
  | { type: "removeDirectories", directories: string[], destination: PermissionDestination }

type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
```

**Example — Auto-approve future git commands:**
```json
{
  "behavior": "allow",
  "updatedInput": { "command": "git status" },
  "updatedPermissions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "git:*" }],
      "behavior": "allow",
      "destination": "session"
    }
  ]
}
```

### Timeout Behavior

- If the server never responds to `can_use_tool`, the CLI blocks indefinitely
- The CLI can send `control_cancel_request` to cancel its own pending request
- On transport close, all pending requests are rejected with `"Tool permission stream closed before response received"`

---

## 9. Session Management

### Session ID

- Generated by CLI via `crypto.randomUUID()` on startup
- Included in every outgoing message (`session_id` field)
- Stored in global state, accessible via `U6()` internally
- Use for session resume: `--resume <session-id>`

### Initialization Sequence (Detailed)

The `initialize` control_request should be sent **before** the first `user` message. The exact sequence is:

```
Server                                  CLI
  |                                      |
  |<-- WS connect ----------------------|
  |                                      |
  |-- control_request {initialize} ---->|  (optional: register hooks, MCP, agents)
  |<-- control_response {success} ------|  (returns commands, models, account info)
  |                                      |
  |-- user message --------------------->|  (first prompt)
  |<-- system/init ----------------------|  (tools, model, session_id, etc.)
  |<-- assistant ... --------------------|
  |<-- result ----------------------------|
```

The `initialize` request lets you:
- Set a custom `systemPrompt` or `appendSystemPrompt`
- Register hook callbacks (with `hookCallbackIds` that map to `hook_callback` control requests)
- Register SDK-side MCP server names
- Set a JSON schema for structured output
- Register custom agent definitions

### Multi-Turn Conversations

After receiving a `result` message, you can send another `user` message to continue the conversation. Internally, user messages are queued in `queuedCommands` and processed in a loop by the CLI's `c()` function.

```
Server: {"type":"user","message":{"role":"user","content":"First question"},...}
CLI:    {"type":"system","subtype":"init",...}
CLI:    {"type":"assistant",...}
CLI:    {"type":"result","subtype":"success",...}

Server: {"type":"user","message":{"role":"user","content":"Follow-up"},...}
CLI:    {"type":"assistant",...}
CLI:    {"type":"result","subtype":"success",...}
```

**Duplicate detection**: Messages with a `uuid` field are checked against a dedup function. Duplicates are skipped but acknowledged with `isReplay: true` if `replayUserMessages` is enabled.

**Session end behavior**:
- For single-turn queries: stdin/transport is closed after first result
- For multi-turn (streaming input): CLI keeps running, waiting for more user messages
- The CLI remains alive as long as the WebSocket connection is open

### Session Resume

```bash
claude --sdk-url ws://localhost:8765 --print --output-format stream-json --input-format stream-json --resume <session-id> -p ""
```

When resuming:
1. CLI reads the transcript JSONL file from `~/.claude/projects/<project>/<sessionId>.jsonl`
2. Loads and replays previous messages with `isReplay: true`
3. Sets `sessionId` to the resumed session's ID
4. Then waits for new `user` message

**Resume at specific message**: `--resume-session-at <uuid>` truncates history to that message.

### Fork Session

```bash
claude --sdk-url ws://localhost:8765 --print --output-format stream-json --input-format stream-json --resume <session-id> --fork-session -p ""
```

When forking:
- A NEW session ID is generated
- The old session's messages are loaded as context
- The new session gets a fresh UUID — this allows branching without modifying the original session

### Context Compaction

When the context window fills up:
1. CLI sends `{"type":"system","subtype":"status","status":"compacting"}`
2. After compaction: `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":N}}`
3. Then: `{"type":"system","subtype":"status","status":null}` (compacting ended)

### Result Triggers

| Result Subtype | Trigger |
|----------------|---------|
| `success` | Normal completion — assistant finished responding |
| `error_during_execution` | Unhandled error during tool execution |
| `error_max_turns` | Reached `--max-turns` limit |
| `error_max_budget_usd` | Exceeded USD budget |
| `error_max_structured_output_retries` | Failed structured output after N retries |

---

## 10. Reconnection & Resilience

### WebSocket Reconnection (sd1 class)

| Constant | Value |
|----------|-------|
| Max reconnect attempts | 3 |
| Base reconnect delay | 1000ms |
| Max reconnect delay | 30000ms |
| Backoff formula | `min(1000 * 2^(attempt-1), 30000)` |
| Ping interval | 10000ms |
| Circular buffer capacity | 1000 messages |

### Reconnection Flow

1. WebSocket connection drops
2. CLI attempts reconnect with exponential backoff
3. Sends `X-Last-Request-Id` header with last sent message UUID
4. Server should replay messages sent after that UUID
5. CLI replays buffered outgoing messages from circular buffer
6. After 3 failed attempts → state = "closed", fires close callback

### Keepalive

- CLI sends `{"type":"keep_alive"}` periodically
- WebSocket ping/pong every 10 seconds (Node.js only, skipped on Bun)
- If no pong received before next ping → connection considered dead → triggers reconnect

### Hybrid Transport (kQA) — HTTP POST Resilience

When `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` is set:

| Constant | Value |
|----------|-------|
| Max POST retries | 10 |
| Base POST delay | 500ms |
| Max POST delay | 8000ms |
| Backoff formula | `min(500 * 2^(attempt-1), 8000)` |

URL conversion: `wss://host/ws/path` → `https://host/session/path/events`

POST body format:
```json
{ "events": [<message>] }
```

---

## 11. Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | Bearer token for WebSocket auth (highest priority) |
| `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` | File descriptor to read auth token from |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | Enable hybrid transport (WS receive + HTTP POST send) |
| `CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION` | Sent as `x-environment-runner-version` header |
| `CLAUDE_CODE_REMOTE` | Indicates running in remote mode |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | Remote session identifier |
| `CLAUDE_CODE_CONTAINER_ID` | Container ID for remote environments |

---

## 12. Transport Class Hierarchy

### `ad1` — ProcessInputTransport (Base)

```typescript
class ProcessInputTransport {
  input: ReadableStream;
  replayUserMessages: boolean;
  pendingRequests: Map<string, PendingRequest>;
  inputClosed: boolean;
  unexpectedResponseCallback?: (msg: any) => Promise<void>;

  async *read(): AsyncGenerator<ParsedMessage>;
  async processLine(line: string): Promise<ParsedMessage | undefined>;
  async write(message: any): Promise<void>;
  async sendRequest(request: ControlRequestPayload, schema?: ZodSchema, signal?: AbortSignal): Promise<any>;
  createCanUseTool(onPrompt?: () => void): CanUseToolFn;
  createHookCallback(callbackId: string, timeout: number): HookCallback;
  async sendMcpMessage(serverName: string, message: any): Promise<any>;
  getPendingPermissionRequests(): ControlRequest[];
}
```

### `sd1` — WebSocketTransport

```typescript
class WebSocketTransport {
  ws: WebSocket | null;
  url: URL;
  state: "idle" | "connecting" | "reconnecting" | "connected" | "closing" | "closed";
  headers: Record<string, string>;
  sessionId: string | undefined;
  reconnectAttempts: number;
  messageBuffer: CircularBuffer;  // capacity: 1000

  async connect(): Promise<void>;
  sendLine(data: string): boolean;
  async write(message: any): Promise<void>;
  handleConnectionError(): void;      // exponential backoff reconnect
  replayBufferedMessages(lastReceivedId: string): void;
  startPingInterval(): void;          // 10s ping/pong
  close(): void;
  setOnData(cb: (data: string) => void): void;
  setOnClose(cb: () => void): void;
}
```

### `kQA` — HybridTransport (extends sd1)

```typescript
class HybridTransport extends WebSocketTransport {
  postUrl: string;  // wss://host/ws/path → https://host/session/path/events

  async write(message: any): Promise<void>;  // HTTP POST with retry
}
```

### `LQA` — SdkUrlTransport (extends ad1)

```typescript
class SdkUrlTransport extends ProcessInputTransport {
  url: URL;
  transport: WebSocketTransport | HybridTransport;
  inputStream: PassThrough;

  constructor(sdkUrl: string, replayStream?: AsyncIterable<string>, replayUserMessages?: boolean);
  async write(message: any): Promise<void>;  // delegates to transport
  close(): void;
}
```

### `fFA` — DirectConnectWebSocket (Browser Client)

This is the simplest client implementation — useful as a reference for building your own:

```typescript
class DirectConnectWebSocket {
  ws: WebSocket | null;
  config: { wsUrl: string; authToken?: string };
  callbacks: {
    onMessage: (msg: any) => void;
    onConnected?: () => void;
    onDisconnected?: () => void;
    onError?: (err: Error) => void;
    onPermissionRequest: (request: CanUseToolRequest, requestId: string) => void;
  };

  connect(): void;
  sendMessage(content: string): boolean;
  respondToPermissionRequest(requestId: string, response: PermissionResponse): void;
  sendInterrupt(): void;
  disconnect(): void;
  isConnected(): boolean;
}
```

**Key implementation details from `fFA`:**
```javascript
// Sending a user message
sendMessage(content) {
  const msg = JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: ""
  });
  this.ws.send(msg);
}

// Responding to a permission request
respondToPermissionRequest(requestId, response) {
  const msg = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior: response.behavior, ...response }
    }
  });
  this.ws.send(msg);
}

// Sending an interrupt
sendInterrupt() {
  const msg = JSON.stringify({
    type: "control_request",
    request_id: crypto.randomUUID(),
    request: { subtype: "interrupt" }
  });
  this.ws.send(msg);
}
```

---

## 13. Implementation Guide

### Minimal WebSocket Server (Bun)

```typescript
const messages: any[] = [];

Bun.serve({
  port: 8765,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("WebSocket server for Claude Code", { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("[CONNECTED] Claude Code connected");
    },
    message(ws, data) {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        messages.push({ direction: "IN", ...msg });

        // Handle system/init
        if (msg.type === "system" && msg.subtype === "init") {
          console.log(`[INIT] session=${msg.session_id} model=${msg.model}`);

          // Send first user message
          const userMsg = JSON.stringify({
            type: "user",
            message: { role: "user", content: "Hello! What can you do?" },
            parent_tool_use_id: null,
            session_id: msg.session_id
          }) + "\n";
          ws.send(userMsg);
        }

        // Handle permission requests
        if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
          console.log(`[PERMISSION] ${msg.request.tool_name}: ${JSON.stringify(msg.request.input)}`);

          // Auto-approve everything (or add your logic here)
          const response = JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: msg.request_id,
              response: {
                behavior: "allow",
                updatedInput: msg.request.input
              }
            }
          }) + "\n";
          ws.send(response);
        }

        // Handle assistant messages
        if (msg.type === "assistant") {
          const text = msg.message?.content
            ?.filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
          console.log(`[ASSISTANT] ${text?.substring(0, 200)}`);
        }

        // Handle result
        if (msg.type === "result") {
          console.log(`[RESULT] ${msg.subtype} | cost=$${msg.total_cost_usd} | turns=${msg.num_turns}`);
        }

        // Ignore keep_alive
        if (msg.type === "keep_alive") return;
      }
    },
    close(ws) {
      console.log("[DISCONNECTED]");
    }
  }
});

console.log("WebSocket server running on ws://localhost:8765");
```

### Launch Claude Code

```bash
claude --sdk-url ws://localhost:8765 \
       --print \
       --output-format stream-json \
       --input-format stream-json \
       --verbose \
       -p ""
```

### Building a Full Controller

To build a production controller on top of this protocol:

1. **WebSocket Server**: Accept connections, handle NDJSON messages
2. **Message Router**: Dispatch by `type` field (system, assistant, result, control_request, etc.)
3. **Permission Handler**: Implement policy for `can_use_tool` requests (auto-approve, deny, or prompt user)
4. **Session Manager**: Track session_id, support resume via `--resume`
5. **Multi-Turn**: Send additional `user` messages after each `result`
6. **Streaming**: Process `stream_event` messages for real-time output
7. **Error Handling**: Handle `result` with `is_error: true`, connection drops, reconnection
8. **Lifecycle**: Use `initialize` control_request for hooks/MCP, `interrupt` to abort

### Key Differences from the Filesystem Inbox Protocol

| Aspect | Filesystem Inbox | WebSocket Protocol |
|--------|-----------------|-------------------|
| Transport | JSON files in `~/.claude/teams/` | NDJSON over WebSocket |
| Permissions | Not natively routed through inbox | Full `can_use_tool` flow |
| Latency | Polling (500ms) | Real-time |
| Multi-turn | Send message → poll for response | Send message → stream response |
| Streaming | Not supported | `stream_event` messages |
| Session control | Limited (mode, shutdown) | Full (model, thinking, MCP, rewind) |
| Dependency | Teammate mode required | Standalone (`--print` mode) |

---

## 14. MCP Channels (Codename: "tengu harbor")

> Added in v2.1.81. This is an experimental feature gated behind feature flags.

MCP Channels enable push notifications from MCP servers into Claude Code sessions. This is separate from auto-update channels (`latest`/`stable`).

### CLI Flags

| Flag | Purpose |
|------|---------|
| `--channels <servers...>` | Register MCP servers for inbound push notifications (hidden flag) |
| `--dangerously-load-development-channels <servers...>` | Load unvetted channel servers for local dev |

### Gating (6 levels)

1. **Capability**: Server must declare `experimental["claude/channel"]`
2. **Feature flag**: `tengu_harbor` LaunchDarkly flag must be enabled
3. **Auth**: Requires claude.ai OAuth authentication
4. **Policy**: For Teams/Enterprise, `policySettings.channelsEnabled` must be `true`
5. **Session**: Server must be in the `--channels` list for the session
6. **Allowlist**: Plugin must be on approved channels allowlist (`tengu_harbor_ledger`)

### MCP Notification Methods

| Method | Direction | Purpose |
|--------|-----------|---------|
| `notifications/claude/channel` | MCP Server → CLI | Inbound message from MCP server |
| `notifications/claude/channel/permission` | CLI → MCP Server | Permission response (allow/deny) |
| `notifications/claude/channel/permission_request` | MCP Server → CLI | Permission request from channel |

**Notification payload:**
```typescript
{
  content: string;
  meta?: Record<string, string>;
}
```

### Message Format

Channel messages are wrapped in XML and injected as user prompts:

```xml
<channel source="server-name" key="value">
message content
</channel>
```

Injected with `priority: "next"`, `isMeta: true`, `origin: { kind: "channel", server: name }`.

### Auto-Update Channels

Separate from MCP channels. Two release channels:

| Channel | npm dist-tag | Description |
|---------|-------------|-------------|
| `latest` (default) | `latest` | Default release channel |
| `stable` | `stable` | Stable release channel |

Configured via `autoUpdatesChannel` in `~/.claude/settings.json`. Version resolution endpoint:
```
https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/{channel}
```

---

## Appendix: Permission Mode Reference

| Mode | `can_use_tool` sent? | Behavior |
|------|---------------------|----------|
| `default` | Yes (when rules don't resolve) | Normal flow |
| `acceptEdits` | Yes (for non-edit tools) | Auto-approves file edits |
| `bypassPermissions` | **Never** | Everything auto-approved locally |
| `plan` | Yes (limited) | Read-only exploration mode |
| `delegate` | N/A | Restricted to coordination tools only |
| `dontAsk` | **Never** | Auto-denies unresolved permissions |

---

## Appendix: Shared Types

```typescript
type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "delegate" | "dontAsk";

type HookEvent =
  | "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  | "Notification" | "UserPromptSubmit"
  | "SessionStart" | "SessionEnd"
  | "Stop" | "SubagentStart" | "SubagentStop"
  | "PreCompact" | "PermissionRequest"
  | "Setup" | "TeammateIdle" | "TaskCompleted";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; budget_tokens?: number };
```

---

## IDE Channel

Claude Code integrates with running IDEs (Neovim, Visual Studio Code, Obsidian, Cursor, etc.) via a locally-discovered MCP server exposed by each IDE. Companion reuses the same mechanism the CLI's built-in `/ide` command relies on: a lockfile registry plus the existing `mcp_set_servers` control_request. No new protocol surface is introduced.

### Lockfile Registry (`~/.claude/ide/`)

Each IDE that supports the Claude Code integration writes a lockfile to `~/.claude/ide/`. The filename stem is typically the port the IDE's MCP server is listening on (e.g. `38630.lock`). The file contents are JSON:

```jsonc
{
  "pid": 62243,                                 // PID of the IDE process
  "workspaceFolders": ["/Users/x/repo"],        // one or more absolute paths
  "ideName": "Neovim",                          // human-readable label
  "transport": "ws",                            // newer IDEs: "ws" | "sse"
  "useWebSocket": true,                         // VSCode-style IDEs: boolean
  "running": true,                              // informational flag
  "authToken": "ff3fedac-0efb-4608-a003-..."    // bearer token for the MCP server
}
```

Either `transport` **or** `useWebSocket` is present (not both, in practice). Consumers should treat unknown fields as forward-compat and ignore them.

Entries whose `pid` is no longer alive are stale and must be pruned before use (a simple `process.kill(pid, 0)` succeeds for live PIDs; `ESRCH` means dead). The diagnostic script at `scripts/probe-ide.ts` demonstrates the full enumeration + prune + payload-preview flow.

### Bind via `mcp_set_servers`

Binding a session to an IDE is a **plain `mcp_set_servers` control_request** — the same message type Companion already uses to push user-configured MCP servers. The adapter at `web/server/claude-adapter.ts :: handleOutgoingMcpSetServers` carries the payload verbatim; the CLI treats the `ide` key as a dynamically-scoped MCP server and wires it up exactly as it does for the CLI's own `/ide` command.

Companion emits, browser-outgoing:

```json
{
  "type": "mcp_set_servers",
  "servers": {
    "ide": {
      "type": "ws-ide",
      "url": "ws://127.0.0.1:38630",
      "ideName": "Neovim",
      "authToken": "ff3fedac-0efb-4608-a003-66530036024b",
      "scope": "dynamic"
    }
  }
}
```

Which the adapter translates into a CLI `control_request`:

```json
{
  "type": "control_request",
  "request_id": "...",
  "request": {
    "subtype": "mcp_set_servers",
    "servers": { "ide": { ... }, "...otherUserServers": { ... } }
  }
}
```

### MCP Server Types

The CLI accepts two IDE-specific server types (discovered via probe against claude CLI v2.1.112):

| `type` | Derivation | URL scheme |
|--------|------------|------------|
| `ws-ide` | `useWebSocket === true` **or** `transport === "ws"` | `ws://127.0.0.1:<port>` |
| `sse-ide` | otherwise (falls back to SSE) | `http://127.0.0.1:<port>` |

These are peers of the standard `stdio` / `sse` / `ws` MCP types and are scoped with `scope: "dynamic"` so they don't persist across session restarts.

### Merge Semantics (Critical)

Companion must **not** overwrite the session's full MCP servers map when binding. The correct flow is:

1. Read the current `dynamicMcpConfig` from session state (includes any user-configured MCP servers).
2. Merge `servers.ide = {...}` into that map.
3. Send the full merged map via `mcp_set_servers`.

Unbinding removes only the `ide` key and re-sends the remainder. See `web/server/ws-bridge.ts :: bindIde / unbindIde`.

### Relationship to the CLI's `/ide` Command

The CLI ships its own `/ide` slash command that performs lockfile discovery and binding internally. Companion intercepts `/ide` client-side (in `Composer.tsx`) and renders a richer picker UI, but the underlying bind mechanism — a `mcp_set_servers` with a dynamically-scoped `ide` server — is identical. The CLI never sees the `/ide` text; it only receives the resulting `mcp_set_servers` control_request.

### Diagnostic

Run `bun scripts/probe-ide.ts` from the repo root to enumerate live lockfiles and preview the exact `mcp_set_servers` payload Companion would emit. Useful for bug reports and verifying that a given IDE is advertising itself correctly.
