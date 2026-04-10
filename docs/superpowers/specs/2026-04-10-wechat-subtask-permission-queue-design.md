# WeChat Subtask Permission Queue Design

**Date**: 2026-04-10
**Status**: Draft

## Problem

When a Claude Code session spawns subagents (via the Agent tool), the WeChat bridge has three critical issues:

1. **Subtask stuck**: The WeChat bridge uses a single-slot `pendingPermission` state. When both the main agent and a subagent need permissions concurrently, the second request overwrites the first, leaving the first request permanently unanswered. The subtask gets stuck.

2. **AskUserQuestion lost**: Similarly, `pendingAskQuestion` is a single slot. If a subagent sends AskUserQuestion while another permission is pending, state corruption occurs.

3. **No subtask visibility**: The bridge has zero references to `agent_id` or `parent_tool_use_id`. Subagent tool calls, intermediate text, and status updates are invisible to WeChat users.

## Root Cause Analysis

### Single-slot Permission State

`wechat-bridge.ts` lines 19-31:

```typescript
interface WeChatUserSession {
  pendingPermission: { requestId: string; sessionId: string } | null;  // SINGLE SLOT
  pendingAskQuestion: { ... } | null;  // SINGLE SLOT
}
```

`handlePermissionRequest` (line 1102) unconditionally overwrites:
```typescript
userSession.pendingPermission = { requestId: perm.request_id, sessionId };
```

### No Subagent Awareness

The bridge never reads `agent_id` or `parent_tool_use_id` from messages. All messages from main agent and subagents are processed identically, with no visual distinction.

### Mixed Text Accumulation

`relayData.pendingText` accumulates text from both main agent and subagents. The `message:result` handler resets ALL state, potentially losing subagent text.

## Solution: Concurrent Permission Queue + Subtask Awareness

### Change 1: Multi-slot Permission State

**File**: `web/server/wechat-bridge.ts`

Replace single-slot with Map-based tracking:

```typescript
interface WeChatUserSession {
  // Before:
  // pendingPermission: { requestId; sessionId } | null;
  // pendingAskQuestion: { ... } | null;

  // After:
  pendingPermissions: Map<string, {
    requestId: string;
    sessionId: string;
    toolName: string;
    agentId?: string;
    isAskUserQuestion: boolean;
    createdAt: number;
  }>;

  pendingAskQuestions: Map<string, {
    requestId: string;
    sessionId: string;
    questions: Array<Record<string, unknown>>;
    currentIndex: number;
    answers: Record<string, string>;
    agentId?: string;
  }>;
}
```

### Change 2: handlePermissionRequest — Add to Map, Don't Overwrite

```typescript
private handlePermissionRequest(
  sessionId: string,
  userId: string,
  perm: {
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
    description?: string;
    agent_id?: string;  // NEW: accept from bus event
  },
): void {
  const settings = getSettings();
  const userSession = this.userSessions.get(userId);
  if (!userSession) return;

  const agentLabel = perm.agent_id ? "[子任务] " : "";

  if (perm.tool_name === "AskUserQuestion") {
    const questions = Array.isArray(perm.input.questions)
      ? perm.input.questions as Array<Record<string, unknown>>
      : [];

    userSession.pendingAskQuestions.set(perm.request_id, {
      requestId: perm.request_id,
      sessionId,
      questions,
      currentIndex: 0,
      answers: {},
      agentId: perm.agent_id,
    });

    userSession.pendingPermissions.set(perm.request_id, {
      requestId: perm.request_id,
      sessionId,
      toolName: perm.tool_name,
      agentId: perm.agent_id,
      isAskUserQuestion: true,
      createdAt: Date.now(),
    });

    // Show first question with agent label
    this.sendReply(userId, `${agentLabel}${formatSingleQuestion(questions, 0)}`);
    return;
  }

  if (settings.wechatAutoApproveSafe && !isDangerousTool(perm.tool_name, perm.input)) {
    this.wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
    const formatted = formatToolCall(perm.tool_name, perm.input);
    this.sendReply(userId, formatted
      ? `✅ 自动批准: ${agentLabel}${formatted}`
      : `✅ 自动批准: ${agentLabel}${perm.tool_name}`);
  } else if (settings.wechatForwardDangerous) {
    userSession.pendingPermissions.set(perm.request_id, {
      requestId: perm.request_id,
      sessionId,
      toolName: perm.tool_name,
      agentId: perm.agent_id,
      isAskUserQuestion: false,
      createdAt: Date.now(),
    });
    this.sendReply(userId, `${agentLabel}${formatPermissionRequest(perm.tool_name, perm.input, perm.description)}`);
  } else {
    this.wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
  }
}
```

### Change 3: User Response Routing — FIFO from Map

For `/allow` `/deny` commands:

```typescript
private async cmdPermissionResponse(userId: string, behavior: "allow" | "deny"): Promise<void> {
  const userSession = this.userSessions.get(userId);
  if (!userSession || userSession.pendingPermissions.size === 0) {
    await this.sendReply(userId, "No pending permission request.");
    return;
  }

  // Take the oldest pending permission (FIFO)
  const [requestId, pending] = userSession.pendingPermissions.entries().next().value;
  userSession.pendingPermissions.delete(requestId);

  this.wsBridge.injectPermissionResponse(pending.sessionId, requestId, behavior);
  const agentLabel = pending.agentId ? "[子任务] " : "";
  await this.sendReply(userId,
    `${agentLabel}Permission ${behavior === "allow" ? "approved" : "denied"}.`);
}
```

For AskUserQuestion numeric responses — route by finding the first active AskUserQuestion:

```typescript
// In handleMessage, check for pending AskUserQuestion
if (userSession && userSession.pendingAskQuestions.size > 0) {
  // Take the first active AskUserQuestion
  const [requestId, pending] = userSession.pendingAskQuestions.entries().next().value;

  const num = parseInt(text.trim(), 10);
  const q = pending.questions[pending.currentIndex];
  const options = Array.isArray(q?.options) ? q.options as Array<Record<string, string>> : [];

  let selectedLabel: string;
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    selectedLabel = options[num - 1].label;
  } else {
    selectedLabel = text.trim();
  }

  pending.answers[String(pending.currentIndex)] = selectedLabel;
  const agentLabel = pending.agentId ? "[子任务] " : "";
  await this.sendReply(userId, `✅ ${agentLabel}已选择: ${selectedLabel}`);

  const nextIndex = pending.currentIndex + 1;
  if (nextIndex < pending.questions.length) {
    pending.currentIndex = nextIndex;
    this.sendReply(userId, `${agentLabel}${formatSingleQuestion(pending.questions, nextIndex)}`);
  } else {
    // All answered
    userSession.pendingAskQuestions.delete(requestId);
    userSession.pendingPermissions.delete(requestId);
    this.wsBridge.injectPermissionResponse(pending.sessionId, requestId, "allow", {
      questions: pending.questions,
      answers: pending.answers,
    });
  }
  return;
}
```

### Change 4: Subtask-aware Tool Notifications

In the `message:assistant` handler, check for `parent_tool_use_id`:

```typescript
const unsubAssistant = companionBus.on("message:assistant", ({ sessionId: sid, message }) => {
  if (sid !== sessionId) return;

  const raw = msg as Record<string, unknown>;
  const parentToolUseId = raw.parent_tool_use_id as string | undefined;
  const agentPrefix = parentToolUseId ? "[子任务] " : "";

  // ... existing text fallback logic ...

  const tools = extractToolUses(message);
  for (const t of tools) {
    const formatted = formatToolCall(t.name, parsedInput);
    if (!formatted) continue;
    const labeled = `${agentPrefix}${formatted}`;
    // ... send or buffer labeled ...
  }
});
```

### Change 5: Permission Cancelled — Clean from Map

```typescript
const unsubPermCancel = companionBus.on("session:permission-cancelled", ({ sessionId: sid, requestId }) => {
  if (sid !== sessionId) return;
  const userSession = this.userSessions.get(userId);
  if (!userSession) return;

  userSession.pendingPermissions.delete(requestId);
  userSession.pendingAskQuestions.delete(requestId);

  if (userSession.pendingPermissions.size === 0) {
    // No more pending permissions
  }
});
```

### Change 6: Migration for getOrCreateUserSession

```typescript
private getOrCreateUserSession(userId: string): WeChatUserSession {
  let userSession = this.userSessions.get(userId);
  if (!userSession) {
    userSession = {
      sessionIds: [],
      activeSessionIndex: 0,
      pendingPermissions: new Map(),      // NEW
      pendingAskQuestions: new Map(),      // NEW
      verboseMode: false,
    };
    this.userSessions.set(userId, userSession);
  }
  return userSession;
}
```

Also add a migration path for existing userSessions that have the old single-slot format (since sessions are persisted to disk).

## Files Changed

| File | Changes |
|------|---------|
| `web/server/wechat-bridge.ts` | Multi-slot permission state, subtask labels, concurrent AskUserQuestion |
| `web/server/wechat-formatter.ts` | Add `agentPrefix` parameter to formatters (optional) |

## Not Changed

- `ws-bridge.ts` — already uses `Map<string, PermissionRequest>` for `pendingPermissions`
- `claude-adapter.ts` — already extracts `agent_id` from CLI messages
- `session-state-machine.ts` — same-state no-op already handles concurrent transitions
- AI validation — WeChat sessions already skip AI validation

## Testing

- Unit test: concurrent permission requests don't overwrite each other
- Unit test: AskUserQuestion from subagent is displayed with `[子任务]` label
- Unit test: `/allow` resolves FIFO, doesn't skip requests
- Unit test: permission cancelled event cleans up from Map
- Integration test: subagent permission flow end-to-end
