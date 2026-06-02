# Codex App-Server Protocol Mapping

This document describes how the Codex `app-server` JSON-RPC protocol maps to The Companion's internal browser message protocol. The adapter (`web/server/codex-adapter.ts`) performs this translation so the frontend doesn't need to know which backend is running.

## Architecture

```
Browser (React)  <-->  WebSocket  <-->  Hono Server  <-->  stdio (JSON-RPC)  <-->  codex app-server
                       /ws/browser/:id       ws-bridge.ts      codex-adapter.ts          (subprocess)
```

The Codex adapter communicates with the `codex app-server` binary via stdin/stdout using newline-delimited JSON-RPC 2.0.

## Transport Comparison

| | Claude Code | Codex |
|---|---|---|
| Transport | WebSocket (CLI connects back via `--sdk-url`) | stdio (server spawns `codex app-server`) |
| Protocol | NDJSON (newline-delimited JSON) | JSON-RPC 2.0 (newline-delimited) |
| Connection | CLI connects TO server | Server spawns and owns process |
| Reconnect | CLI has built-in WS reconnection | Respawn process, use `thread/resume` |

## Initialization Sequence

```
Server → Codex:  {"method":"initialize","id":1,"params":{"clientInfo":{"name":"the-companion",...},"capabilities":{}}}
Codex → Server:  {"id":1,"result":{...capabilities...}}
Server → Codex:  {"method":"initialized","params":{}}
Server → Codex:  {"method":"thread/start","id":2,"params":{"model":"...","cwd":"...","approvalPolicy":"...","sandbox":"workspace-write"}}
Codex → Server:  {"id":2,"result":{"thread":{"id":"thr_abc123"}}}
```

For session resume:
```
Server → Codex:  {"method":"thread/resume","id":2,"params":{"threadId":"thr_abc123","model":"...","cwd":"...","approvalPolicy":"...","sandbox":"workspace-write"}}
```

## Approval Policy Mapping

The UI permission modes map to Codex approval policies via `mapApprovalPolicy()`:

| UI Permission Mode | Codex `approvalPolicy` | Behavior |
|---|---|---|
| `bypassPermissions` | `"never"` | Auto-approve all tool calls |
| `acceptEdits` | `"untrusted"` | Prompt for untrusted operations |
| `plan` | `"untrusted"` | Prompt for untrusted operations |
| `default` | `"untrusted"` | Prompt for untrusted operations |

Valid Codex enum values (kebab-case only):
- **sandbox**: `"read-only"`, `"workspace-write"`, `"danger-full-access"`
- **approvalPolicy**: `"never"`, `"untrusted"`, `"on-failure"`, `"on-request"`

## Message Translation: Codex → Browser

### Notifications (Codex → Server → Browser)

| Codex JSON-RPC Notification | Browser Message Type | Notes |
|---|---|---|
| `item/started` (agentMessage) | `stream_event` (message_start + content_block_start) | Opens streaming accumulation |
| `item/agentMessage/delta` | `stream_event` (content_block_delta) | Streaming text chunks |
| `item/completed` (agentMessage) | `stream_event` (content_block_stop + message_delta) then `assistant` | Finalizes text message |
| `item/started` (commandExecution) | `assistant` with `tool_use` block (name=`"Bash"`) | Shows command about to execute |
| `item/completed` (commandExecution) | `assistant` with `tool_result` block | Shows stdout/stderr output |
| `item/started` (fileChange) | `assistant` with `tool_use` block (name=`"Write"` or `"Edit"`) | Create → Write, modify → Edit |
| `item/completed` (fileChange) | `assistant` with `tool_result` block | Shows change summary |
| `item/started` (mcpToolCall) | `assistant` with `tool_use` block (name=`"mcp:{server}:{tool}"`) | MCP tool invocation |
| `item/completed` (mcpToolCall) | `assistant` with `tool_result` block | MCP result or error |
| `item/started` (webSearch) | `assistant` with `tool_use` block (name=`"WebSearch"`) | Search query |
| `item/completed` (webSearch) | `assistant` with `tool_result` block | URL or query result |
| `item/started` (reasoning) | `stream_event` (content_block_start, type=thinking) | Opens thinking block |
| `item/completed` (reasoning) | `stream_event` (content_block_stop) | Closes thinking block |
| `item/started` (contextCompaction) | `status_change` (status=`"compacting"`) | Context window compaction |
| `item/completed` (contextCompaction) | `status_change` (status=`null`) | Compaction done |
| `turn/completed` | `result` | Synthesized `CLIResultMessage` with turn status |

### Requests (Codex → Server, server must respond)

| Codex JSON-RPC Request | Browser Message | Server Response |
|---|---|---|
| `item/commandExecution/requestApproval` | `permission_request` (tool_name=`"Bash"`) | `{"id":N,"result":{"decision":"accept"}}` or `"decline"` |
| `item/fileChange/requestApproval` | `permission_request` (tool_name=`"Edit"`) | Same format |
| Unknown request types | Not forwarded | Auto-accepted with `"accept"` |

## Message Translation: Browser → Codex

| Browser Message Type | Codex JSON-RPC Call | Notes |
|---|---|---|
| `user_message` | `turn/start` with `{ prompt, threadId }` | Starts a new turn |
| `permission_response` (allow) | Response: `{ decision: "accept" }` | To the pending request ID |
| `permission_response` (deny) | Response: `{ decision: "decline" }` | To the pending request ID |
| `interrupt` | `turn/interrupt` with `{ threadId, turnId }` | Stops current turn |
| `set_model` | **Not supported** | Logs warning, returns false |
| `set_permission_mode` | **Not supported** | Logs warning, returns false |

## Codex Item Types

Each Codex item goes through a lifecycle: `item/started` → `item/updated` (optional) → `item/completed`.

| Item Type | Description | Mapped Tool Name |
|---|---|---|
| `agentMessage` | Text response from the model | N/A (streamed as text) |
| `commandExecution` | Shell command execution | `Bash` |
| `fileChange` | File creation/modification/deletion | `Write` (create) or `Edit` (modify) |
| `mcpToolCall` | MCP server tool invocation | `mcp:{server}:{tool}` |
| `webSearch` | Web search query | `WebSearch` |
| `reasoning` | Internal model reasoning/thinking | Rendered as thinking block |
| `contextCompaction` | Context window compaction | Status indicator |
| `userMessage` | Echo of user input | Ignored |
| `plan` | Planning step | Not handled yet |
| `enteredReviewMode` | Review mode activation | Not handled yet |

## Session State Mapping

When Codex initializes, a `SessionState` is synthesized for the browser:

| SessionState Field | Source | Notes |
|---|---|---|
| `session_id` | Server-generated UUID | Same as Claude sessions |
| `backend_type` | `"codex"` | Always codex |
| `model` | From launch options | e.g., `"gpt-5.3-codex"` |
| `cwd` | From launch options | Working directory |
| `permissionMode` | Approval mode string | Raw UI mode value |
| `tools` | `[]` | Not extracted from Codex yet |
| `mcp_servers` | `[]` | Not extracted yet |
| `total_cost_usd` | `0` | Not tracked yet |
| `context_used_percent` | `0` | Not tracked yet |
| `git_branch` | `""` | Not queried yet |

## Known Gaps

| Feature | Status | Notes |
|---|---|---|
| Token usage / cost tracking | Hardcoded to 0 | Need to extract from `turn/completed` |
| Runtime model switching | Not supported | Codex sets model at `thread/start` |
| Runtime permission switching | Not supported | Set at `thread/start` |
| Git metadata in session state | Not populated | Could query git after init |
| Streaming reasoning tokens | Bulk only | `item/reasoning/delta` not handled |
| MCP/WebSearch approval requests | Not handled | Auto-accepted |

## File Reference

| File | Role |
|---|---|
| `web/server/codex-adapter.ts` | Core adapter: JSON-RPC transport + message translation |
| `web/server/codex-adapter.test.ts` | Unit tests (28 tests) |
| `web/server/cli-launcher.ts` | Spawns `codex app-server`, creates adapter, manages lifecycle |
| `web/server/ws-bridge.ts` | Attaches adapter, forwards messages to browsers |
| `web/server/session-types.ts` | Shared types (`BrowserIncomingMessage`, `BrowserOutgoingMessage`) |
| `web/src/utils/backends.ts` | Frontend model/mode lists per backend |
| `web/server/routes.ts` | Backend detection (`GET /api/backends`), model listing |
