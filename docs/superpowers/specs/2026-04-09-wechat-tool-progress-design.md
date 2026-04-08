# WeChat Tool Execution Progress Notifications

**Date:** 2026-04-09
**Status:** Draft

## Problem

When a user sends a message to the WeChat bot, the bot appears silent during execution. Only permission requests trigger messages. Users cannot tell whether the AI is working, thinking, or stuck. The only feedback is a 15-second delayed progress indicator (`⏳ 正在处理...`).

## Goal

Push real-time tool execution summaries to WeChat so users know what the AI is doing. Each tool call (read file, run command, search, etc.) should produce a visible notification. Failures should be reported immediately.

## Requirements

1. **Tool call notifications** — every tool execution sends a summary to WeChat (e.g. `📖 读取: src/index.ts`)
2. **Batch mode (default)** — tool calls are buffered and flushed every 3 seconds as a single merged message
3. **Verbose mode** — each tool call is sent immediately as a separate message
4. **`/verbose` command** — toggles between batch and verbose mode per user
5. **Failure notifications** — tool errors are sent immediately regardless of mode
6. **Default enabled** — all users see tool progress without configuration
7. **Persisted preference** — verbose/batch choice survives restarts
8. **Remove old progress indicator** — the 15-second `⏳ 正在处理...` logic is superseded

## Architecture

### Approach

Modify the existing `message:assistant` handler in `wechat-bridge.ts`. Tool calls are already extracted via `extractToolUses()` and `formatToolCall()` — they are currently silently accumulated. The change is to route them through a batch buffer instead of suppressing them.

Tool result failures are detected by scanning `tool_result` content blocks in `message:assistant` events where `is_error === true`. The `tool_result` block contains `tool_use_id` but not the tool name — `extractToolResults()` resolves the name by matching `tool_use_id` against previously recorded tool calls in `toolAccumulator`.

### Data Structure Changes

**`SessionRelayData` new fields:**

```typescript
interface SessionRelayData {
  // existing fields unchanged
  pendingText: string;
  lastTypingTs: number;
  streamlinedSent: boolean;
  contentSent: boolean;
  lastBlockIndex: number;
  toolAccumulator: ToolCallInfo[];
  lastUserFacingMessageTs: number;
  progressSent: boolean;  // retained but no longer used for 15s indicator

  // new fields
  toolNotifyBuffer: string[];              // pending formatted tool summaries for batch mode
  toolNotifyTimer: NodeJS.Timeout | null;  // batch flush timer
}
```

**`WeChatUserSession` new field:**

```typescript
interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermission: { requestId: string; sessionId: string } | null;
  verboseMode: boolean;  // false = batch, true = per-message
}
```

### Message Flow

#### Tool Call Processing (`message:assistant`)

```
message:assistant arrives
  |
  ├─ Extract tool_use blocks
  │   ├─ Store in toolAccumulator (kept for backward compat)
  │   └─ For each: formatToolCall(name, input)
  │       ├─ If returns "" (suppressed tools like TodoWrite) → skip
  │       ├─ If verboseMode=true  → sendReply() immediately
  │       └─ If verboseMode=false → push to toolNotifyBuffer
  │           └─ If no timer running → start 3s timer
  │               → On timer fire: merge buffer, sendReply(), clear buffer
  │
  └─ Extract tool_result blocks (is_error=true)
      └─ formatToolCallFailure() → sendReply() immediately (always, ignore mode)
```

#### Batch Timer Logic

```
Tool call arrives, verboseMode=false:
  1. Push formatted string to toolNotifyBuffer
  2. If toolNotifyTimer is null:
     - Set timer for 3 seconds
     - On fire: flushBuffer()
  3. If toolNotifyTimer exists:
     - Buffer already has pending items, new item is appended
     - Timer continues (no reset needed — fire time is fixed from first item)

flushBuffer():
  1. Take all items from toolNotifyBuffer
  2. Join with newlines → single message
  3. sendReply()
  4. Clear toolNotifyBuffer
  5. Set toolNotifyTimer = null
```

#### Failure Notification

```typescript
// extractToolResults resolves tool_name via tool_use_id → toolAccumulator lookup
// toolAccumulator entries must include tool_use_id for this matching.
// Existing ToolCallInfo type is extended with an optional toolUseId field.
const toolResults = extractToolResults(message, relayData?.toolAccumulator ?? []);
for (const result of toolResults) {
  if (result.is_error) {
    const msg = formatToolCallFailure(result.toolName, result.content);
    sendReply(userId, msg);  // immediate, bypasses batch/verbose
  }
}
```

New formatter function:

```typescript
export function formatToolCallFailure(toolName: string, content: string): string {
  return `❌ 失败: ${toolName}\n${truncate(content, 300)}`;
}
```

#### Result Handler Adjustment (`message:result`)

Current behavior sends `formatToolSummary(toolAccumulator)` at result time. With tool notifications now sent during execution, this summary is redundant.

**Change:** Remove the tool summary sending from `message:result`. Only send the final text response and error messages.

### `/verbose` Command

| Input | Effect | Reply |
|-------|--------|-------|
| `/verbose` | Toggle verboseMode on/off | `🔔 已切换到逐条模式 — 每个操作即时推送` or `🔕 已切换到批量模式 — 操作每3秒合并推送` |
| `/status` | Extend existing output | Append: `工具通知: 批量/逐条` |

### Persistence

`verboseMode` is stored in `~/.companion/wechat-sessions.json` alongside existing fields:

```json
{
  "user-abc": {
    "sessionIds": ["sess-1"],
    "activeSessionIndex": 0,
    "verboseMode": false
  }
}
```

Backward compatible: existing entries without `verboseMode` default to `false` on load.

### Cleanup

On `cleanupRelay()` and in `message:result`:

```typescript
if (relayData.toolNotifyTimer) {
  clearTimeout(relayData.toolNotifyTimer);
  relayData.toolNotifyTimer = null;
}
relayData.toolNotifyBuffer = [];
```

### Suppressed Tools

Tools that return empty string from `formatToolCall()` are excluded from notifications:
- `TodoWrite`, `TodoRead`, `TaskList`, `TaskGet`

### Permission Request Coexistence

When a dangerous tool (Bash, Write, Edit) triggers a permission request:
1. Tool call summary is sent first (e.g. `🔧 执行: rm -rf dist`)
2. Permission request follows (e.g. `⚠️ 需要批准操作`)
3. User sees what will happen before deciding to approve

No changes needed — the tool notification flows naturally before the permission handler runs.

## Files Changed

| File | Change |
|------|--------|
| `web/server/wechat-bridge.ts` | RelayData structure, assistant handler, batch timer, /verbose command, cleanup, remove 15s progress indicator |
| `web/server/wechat-formatter.ts` | Add `formatToolCallFailure()` and `extractToolResults()` helper |
| `web/server/wechat-bridge.test.ts` | Batch mode, verbose mode, failure notification, /verbose command tests |
| `web/server/wechat-formatter.test.ts` | `formatToolCallFailure` tests |

## Out of Scope

- Streaming AI thought text to WeChat (too verbose for chat interface)
- Tool execution duration reporting
- UNC paths handling
- Changes to Web UI or other bridge consumers
