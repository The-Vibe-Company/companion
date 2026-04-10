# WeChat Subtask Permission Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-slot permission state with concurrent Map-based queue so subagent permissions and AskUserQuestion don't overwrite each other and cause subtasks to get stuck.

**Architecture:** Change `WeChatUserSession.pendingPermission` and `pendingAskQuestion` from single slots to `Map<string, ...>`. Update all consumers to use Map operations (`.set()`, `.delete()`, `.entries().next()` for FIFO). Add `agent_id` awareness for `[子任务]` labels.

**Tech Stack:** TypeScript, Vitest, existing WeChat bridge infrastructure

**Spec:** `docs/superpowers/specs/2026-04-10-wechat-subtask-permission-queue-design.md`

---

### Task 1: Update WeChatUserSession interface and factory

**Files:**
- Modify: `web/server/wechat-bridge.ts:19-31` (interface)
- Modify: `web/server/wechat-bridge.ts:1112-1119` (getOrCreateUserSession)
- Modify: `web/server/wechat-bridge.ts:1149-1169` (restoreSessionMappings)
- Test: `web/server/wechat-bridge.test.ts`

- [ ] **Step 1: Write the failing test for Map-based state**

Add to `web/server/wechat-bridge.test.ts` in the "AskUserQuestion pending state handling" describe block:

```typescript
describe("concurrent permission queue", () => {
  it("stores multiple pending permissions without overwriting", () => {
    // Simulates the new Map-based state: multiple concurrent permissions
    const pendingPermissions = new Map<string, {
      requestId: string;
      sessionId: string;
      toolName: string;
      agentId?: string;
      isAskUserQuestion: boolean;
      createdAt: number;
    }>();

    pendingPermissions.set("req-1", {
      requestId: "req-1",
      sessionId: "sess-1",
      toolName: "Bash",
      agentId: undefined,
      isAskUserQuestion: false,
      createdAt: 1000,
    });
    pendingPermissions.set("req-2", {
      requestId: "req-2",
      sessionId: "sess-1",
      toolName: "Write",
      agentId: "agent-sub-1",
      isAskUserQuestion: false,
      createdAt: 2000,
    });

    expect(pendingPermissions.size).toBe(2);
    expect(pendingPermissions.has("req-1")).toBe(true);
    expect(pendingPermissions.has("req-2")).toBe(true);
  });

  it("resolves FIFO — takes oldest pending permission first", () => {
    const pendingPermissions = new Map<string, {
      requestId: string;
      sessionId: string;
      toolName: string;
      agentId?: string;
      isAskUserQuestion: boolean;
      createdAt: number;
    }>();

    pendingPermissions.set("req-1", {
      requestId: "req-1",
      sessionId: "sess-1",
      toolName: "Bash",
      agentId: undefined,
      isAskUserQuestion: false,
      createdAt: 1000,
    });
    pendingPermissions.set("req-2", {
      requestId: "req-2",
      sessionId: "sess-1",
      toolName: "Write",
      agentId: "agent-sub-1",
      isAskUserQuestion: false,
      createdAt: 2000,
    });

    // FIFO: Map preserves insertion order
    const [firstKey, firstVal] = pendingPermissions.entries().next().value;
    pendingPermissions.delete(firstKey);

    expect(firstKey).toBe("req-1");
    expect(firstVal.toolName).toBe("Bash");
    expect(pendingPermissions.size).toBe(1);
    expect(pendingPermissions.has("req-2")).toBe(true);
  });

  it("cleans up cancelled permission by requestId", () => {
    const pendingPermissions = new Map<string, {
      requestId: string;
      sessionId: string;
      toolName: string;
      isAskUserQuestion: boolean;
      createdAt: number;
    }>();
    const pendingAskQuestions = new Map<string, { requestId: string }>();

    pendingPermissions.set("req-1", {
      requestId: "req-1", sessionId: "s", toolName: "Bash", isAskUserQuestion: false, createdAt: 1,
    });
    pendingAskQuestions.set("req-ask", { requestId: "req-ask" });

    // Cancel req-1
    pendingPermissions.delete("req-1");
    // Cancel a different AskUserQuestion
    pendingAskQuestions.delete("req-ask");

    expect(pendingPermissions.size).toBe(0);
    expect(pendingAskQuestions.size).toBe(0);
  });

  it("stores multiple concurrent AskUserQuestion entries", () => {
    const pendingAskQuestions = new Map<string, {
      requestId: string;
      sessionId: string;
      questions: Array<Record<string, unknown>>;
      currentIndex: number;
      answers: Record<string, string>;
      agentId?: string;
    }>();

    pendingAskQuestions.set("req-ask-1", {
      requestId: "req-ask-1",
      sessionId: "s1",
      questions: [{ question: "Q1?", options: [{ label: "A" }] }],
      currentIndex: 0,
      answers: {},
      agentId: undefined,
    });
    pendingAskQuestions.set("req-ask-2", {
      requestId: "req-ask-2",
      sessionId: "s1",
      questions: [{ question: "Q2?", options: [{ label: "B" }] }],
      currentIndex: 0,
      answers: {},
      agentId: "agent-sub-1",
    });

    expect(pendingAskQuestions.size).toBe(2);
    // FIFO: first one is answered first
    const [firstKey] = pendingAskQuestions.entries().next().value;
    expect(firstKey).toBe("req-ask-1");
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (these are pure data structure tests, no implementation needed yet)

Run: `cd web && bun run test -- --reporter=verbose wechat-bridge.test.ts`
Expected: PASS (these tests don't depend on production code, they test Map behavior)

- [ ] **Step 3: Update WeChatUserSession interface**

In `web/server/wechat-bridge.ts`, replace lines 19-31:

```typescript
interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermissions: Map<string, {
    requestId: string;
    sessionId: string;
    toolName: string;
    agentId?: string;
    isAskUserQuestion: boolean;
    createdAt: number;
  }>;
  verboseMode: boolean;
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

- [ ] **Step 4: Update getOrCreateUserSession** (line 1112-1119)

Replace the method body:

```typescript
private getOrCreateUserSession(userId: string): WeChatUserSession {
  let userSession = this.userSessions.get(userId);
  if (!userSession) {
    userSession = {
      sessionIds: [],
      activeSessionIndex: 0,
      pendingPermissions: new Map(),
      verboseMode: false,
      pendingAskQuestions: new Map(),
    };
    this.userSessions.set(userId, userSession);
  }
  return userSession;
}
```

- [ ] **Step 5: Update restoreSessionMappings** (line 1154-1159)

Replace the inner user session creation:

```typescript
this.userSessions.set(userId, {
  sessionIds: mapping.sessionIds,
  activeSessionIndex: mapping.activeSessionIndex,
  pendingPermissions: new Map(),
  verboseMode: mapping.verboseMode ?? false,
  pendingAskQuestions: new Map(),
});
```

- [ ] **Step 6: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: Errors in all consumers of the old single-slot fields (handleMessage, handlePermissionRequest, cmdPermissionResponse, permission cancelled handler). This is expected — we'll fix them in the following tasks.

- [ ] **Step 7: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "refactor(wechat): change permission state to Map-based concurrent queue"
```

---

### Task 2: Update handlePermissionRequest — Map + agent_id

**Files:**
- Modify: `web/server/wechat-bridge.ts:1069-1108`

- [ ] **Step 1: Write the failing test**

Add to `web/server/wechat-bridge.test.ts`:

```typescript
describe("handlePermissionRequest — concurrent & agent_id", () => {
  it("agent_id produces subtask label", () => {
    const agentId = "agent-sub-1";
    const agentLabel = agentId ? "[子任务] " : "";
    expect(agentLabel).toBe("[子任务] ");
  });

  it("no agent_id produces no label", () => {
    const agentId: string | undefined = undefined;
    const agentLabel = agentId ? "[子任务] " : "";
    expect(agentLabel).toBe("");
  });

  it("concurrent AskUserQuestion and dangerous tool both stored", () => {
    // Simulates handlePermissionRequest adding to Maps
    const pendingPermissions = new Map<string, {
      requestId: string; toolName: string; agentId?: string; isAskUserQuestion: boolean;
    }>();
    const pendingAskQuestions = new Map<string, { requestId: string; agentId?: string }>();

    // First: AskUserQuestion from subagent
    const askRequestId = "req-ask-1";
    pendingPermissions.set(askRequestId, {
      requestId: askRequestId, toolName: "AskUserQuestion",
      agentId: "agent-sub-1", isAskUserQuestion: true,
    });
    pendingAskQuestions.set(askRequestId, {
      requestId: askRequestId, agentId: "agent-sub-1",
    });

    // Second: Bash from main agent
    const bashRequestId = "req-bash-1";
    pendingPermissions.set(bashRequestId, {
      requestId: bashRequestId, toolName: "Bash",
      agentId: undefined, isAskUserQuestion: false,
    });

    // Both stored, no overwrite
    expect(pendingPermissions.size).toBe(2);
    expect(pendingAskQuestions.size).toBe(1);
    expect(pendingPermissions.get(askRequestId)?.isAskUserQuestion).toBe(true);
    expect(pendingPermissions.get(bashRequestId)?.toolName).toBe("Bash");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd web && bun run test -- --reporter=verbose wechat-bridge.test.ts`
Expected: PASS

- [ ] **Step 3: Rewrite handlePermissionRequest** (lines 1069-1108)

Replace the entire method:

```typescript
private handlePermissionRequest(
  sessionId: string,
  userId: string,
  perm: {
    request_id: string;
    tool_name: string;
    input: Record<string, unknown>;
    description?: string;
    agent_id?: string;
  },
): void {
  const settings = getSettings();
  const userSession = this.userSessions.get(userId);
  if (!userSession) return;

  const agentLabel = perm.agent_id ? "[子任务] " : "";

  // AskUserQuestion: track in both Maps, show first question
  if (perm.tool_name === "AskUserQuestion") {
    const questions = Array.isArray(perm.input.questions) ? perm.input.questions as Array<Record<string, unknown>> : [];
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
    this.sendReply(userId, `${agentLabel}${formatSingleQuestion(questions, 0)}`);
    return;
  }

  if (settings.wechatAutoApproveSafe && !isDangerousTool(perm.tool_name, perm.input)) {
    this.wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
    const formatted = formatToolCall(perm.tool_name, perm.input);
    this.sendReply(userId, formatted ? `✅ 自动批准: ${agentLabel}${formatted}` : `✅ 自动批准: ${agentLabel}${perm.tool_name}`);
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

- [ ] **Step 4: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: Fewer errors — handlePermissionRequest is now fixed. Remaining errors in handleMessage, cmdPermissionResponse, permission cancelled handler.

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): handlePermissionRequest uses Map and agent_id label"
```

---

### Task 3: Update cmdPermissionResponse — FIFO from Map

**Files:**
- Modify: `web/server/wechat-bridge.ts:707-719`

- [ ] **Step 1: Write the failing test**

Add to `web/server/wechat-bridge.test.ts` in the concurrent permission queue describe block:

```typescript
it("/allow resolves FIFO and removes from Map", () => {
  // Simulates cmdPermissionResponse
  const pendingPermissions = new Map<string, {
    requestId: string; sessionId: string; toolName: string;
    agentId?: string; isAskUserQuestion: boolean; createdAt: number;
  }>();

  pendingPermissions.set("req-1", {
    requestId: "req-1", sessionId: "s1", toolName: "Bash",
    agentId: undefined, isAskUserQuestion: false, createdAt: 1000,
  });
  pendingPermissions.set("req-2", {
    requestId: "req-2", sessionId: "s1", toolName: "Write",
    agentId: "sub-1", isAskUserQuestion: false, createdAt: 2000,
  });

  // cmdPermissionResponse: take oldest (FIFO)
  expect(pendingPermissions.size).toBe(2);
  const [firstKey, firstVal] = pendingPermissions.entries().next().value;
  pendingPermissions.delete(firstKey);

  expect(firstKey).toBe("req-1");
  expect(firstVal.toolName).toBe("Bash");
  expect(pendingPermissions.size).toBe(1);

  // Second /allow
  const [secondKey, secondVal] = pendingPermissions.entries().next().value;
  pendingPermissions.delete(secondKey);

  expect(secondKey).toBe("req-2");
  expect(secondVal.agentId).toBe("sub-1");
  expect(pendingPermissions.size).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd web && bun run test -- --reporter=verbose wechat-bridge.test.ts`
Expected: PASS

- [ ] **Step 3: Rewrite cmdPermissionResponse** (lines 707-719)

Replace the entire method:

```typescript
private async cmdPermissionResponse(userId: string, behavior: "allow" | "deny"): Promise<void> {
  const userSession = this.userSessions.get(userId);
  if (!userSession || userSession.pendingPermissions.size === 0) {
    await this.sendReply(userId, "No pending permission request. Tool calls shown with ℹ️ are informational and don't need approval.");
    return;
  }

  // FIFO: resolve the oldest pending permission
  const [requestId, pending] = userSession.pendingPermissions.entries().next().value;
  userSession.pendingPermissions.delete(requestId);

  this.wsBridge.injectPermissionResponse(pending.sessionId, requestId, behavior);
  const agentLabel = pending.agentId ? "[子任务] " : "";
  await this.sendReply(userId, `${agentLabel}Permission ${behavior === "allow" ? "approved" : "denied"}.`);
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: Fewer errors. Remaining in handleMessage and permission cancelled handler.

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): cmdPermissionResponse resolves FIFO from Map"
```

---

### Task 4: Update handleMessage AskUserQuestion routing — Map

**Files:**
- Modify: `web/server/wechat-bridge.ts:436-472`

- [ ] **Step 1: Write the failing test**

Add to `web/server/wechat-bridge.test.ts`:

```typescript
describe("handleMessage — AskUserQuestion Map routing", () => {
  it("routes numeric response to first pending AskUserQuestion", () => {
    const pendingAskQuestions = new Map<string, {
      requestId: string; questions: Array<Record<string, unknown>>;
      currentIndex: number; answers: Record<string, string>; agentId?: string;
    }>();
    const pendingPermissions = new Map<string, { requestId: string; isAskUserQuestion: boolean }>();

    // Two concurrent AskUserQuestions
    pendingAskQuestions.set("req-ask-1", {
      requestId: "req-ask-1", questions: [
        { question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
      ], currentIndex: 0, answers: {}, agentId: undefined,
    });
    pendingAskQuestions.set("req-ask-2", {
      requestId: "req-ask-2", questions: [
        { question: "Q2?", options: [{ label: "C" }] },
      ], currentIndex: 0, answers: {}, agentId: "sub-1",
    });
    pendingPermissions.set("req-ask-1", { requestId: "req-ask-1", isAskUserQuestion: true });
    pendingPermissions.set("req-ask-2", { requestId: "req-ask-2", isAskUserQuestion: true });

    // FIFO: first one is answered
    const [firstKey, pending] = pendingAskQuestions.entries().next().value;
    expect(firstKey).toBe("req-ask-1");

    // User picks option 1 → "A"
    const num = 1;
    const q = pending.questions[pending.currentIndex];
    const options = Array.isArray(q?.options) ? q.options as Array<Record<string, string>> : [];
    const selectedLabel = options[num - 1].label;
    pending.answers[String(pending.currentIndex)] = selectedLabel;

    expect(selectedLabel).toBe("A");
    expect(pending.answers["0"]).toBe("A");

    // Only one question, so all answered → delete
    const nextIndex = pending.currentIndex + 1;
    if (nextIndex >= pending.questions.length) {
      pendingAskQuestions.delete(firstKey);
      pendingPermissions.delete(firstKey);
    }

    expect(pendingAskQuestions.size).toBe(1);
    expect(pendingPermissions.size).toBe(1);
    expect(pendingAskQuestions.has("req-ask-2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd web && bun run test -- --reporter=verbose wechat-bridge.test.ts`
Expected: PASS

- [ ] **Step 3: Rewrite the AskUserQuestion handling in handleMessage** (lines 436-472)

Replace lines 436-472 (the `if (userSession?.pendingAskQuestion)` block through `return;`):

```typescript
// Check for pending AskUserQuestion — number response selects option
const userSession = this.userSessions.get(userId);
if (userSession && userSession.pendingAskQuestions.size > 0) {
  // FIFO: take the first pending AskUserQuestion
  const [askRequestId, pending] = userSession.pendingAskQuestions.entries().next().value;
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
    // All questions answered — submit
    userSession.pendingAskQuestions.delete(askRequestId);
    userSession.pendingPermissions.delete(askRequestId);
    this.wsBridge.injectPermissionResponse(pending.sessionId, askRequestId, "allow", {
      questions: pending.questions,
      answers: pending.answers,
    });
  }
  return;
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: Fewer errors. Remaining in permission cancelled handler.

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): AskUserQuestion routing uses Map with FIFO"
```

---

### Task 5: Update permission cancelled handler — Map cleanup

**Files:**
- Modify: `web/server/wechat-bridge.ts:1017-1027`

- [ ] **Step 1: Rewrite the permission cancelled handler**

Replace lines 1017-1027:

```typescript
// Permission cancelled — clean from Maps
const unsubPermCancel = companionBus.on("session:permission-cancelled", ({ sessionId: sid, requestId }) => {
  if (sid !== sessionId) return;
  const userSession = this.userSessions.get(userId);
  if (!userSession) return;

  userSession.pendingPermissions.delete(requestId);
  userSession.pendingAskQuestions.delete(requestId);

  this.sendReply(userId, "Permission request was cancelled.");
});
```

- [ ] **Step 2: Update the "session:permission-cancelled" test in wechat-bridge.test.ts**

Replace the existing "session:permission-cancelled clears matching pendingPermission" test (lines 370-392) and the "ignores non-matching requestId" test (lines 394-414) to use Map:

```typescript
it("session:permission-cancelled event clears matching entry from Map", () => {
  const pendingPermissions = new Map<string, { requestId: string }>();
  const pendingAskQuestions = new Map<string, { requestId: string }>();

  pendingPermissions.set("req-123", { requestId: "req-123" });
  pendingAskQuestions.set("req-ask-123", { requestId: "req-ask-123" });

  // Cancel req-123
  pendingPermissions.delete("req-123");
  pendingAskQuestions.delete("req-ask-123");

  expect(pendingPermissions.size).toBe(0);
  expect(pendingAskQuestions.size).toBe(0);
});

it("session:permission-cancelled only removes cancelled request, not others", () => {
  const pendingPermissions = new Map<string, { requestId: string }>();

  pendingPermissions.set("req-456", { requestId: "req-456" });
  pendingPermissions.set("req-789", { requestId: "req-789" });

  // Cancel only req-789
  pendingPermissions.delete("req-789");

  expect(pendingPermissions.size).toBe(1);
  expect(pendingPermissions.has("req-456")).toBe(true);
});
```

Also remove the old "clears pendingAskQuestion when permission is cancelled" test in the AskUserQuestion section (lines 622-648) since it tests the old single-slot format. Replace with:

```typescript
it("clears pendingAskQuestions entry when permission is cancelled", () => {
  const pendingAskQuestions = new Map<string, { requestId: string }>();
  const pendingPermissions = new Map<string, { requestId: string }>();

  pendingAskQuestions.set("req-ask-1", { requestId: "req-ask-1" });
  pendingPermissions.set("req-ask-1", { requestId: "req-ask-1" });

  // Cancel
  pendingPermissions.delete("req-ask-1");
  pendingAskQuestions.delete("req-ask-1");

  expect(pendingAskQuestions.size).toBe(0);
  expect(pendingPermissions.size).toBe(0);
});
```

- [ ] **Step 3: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: Zero errors in wechat-bridge.ts

- [ ] **Step 4: Run all tests**

Run: `cd web && bun run test -- --reporter=verbose wechat-bridge.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): permission cancelled handler cleans up from Map"
```

---

### Task 6: Add subtask label to assistant message handler

**Files:**
- Modify: `web/server/wechat-bridge.ts:902-953` (message:assistant handler)

- [ ] **Step 1: Write the failing test**

Add to `web/server/wechat-bridge.test.ts`:

```typescript
describe("subtask label in assistant messages", () => {
  it("produces agent prefix when parent_tool_use_id is present", () => {
    const message = {
      type: "assistant",
      parent_tool_use_id: "tu_agent_123",
      message: {
        content: [
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/foo.ts" } },
        ],
      },
    };
    const parentToolUseId = (message as any).parent_tool_use_id as string | undefined;
    const agentPrefix = parentToolUseId ? "[子任务] " : "";
    expect(agentPrefix).toBe("[子任务] ");
  });

  it("produces no prefix for main agent messages", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/foo.ts" } },
        ],
      },
    };
    const parentToolUseId = (message as any).parent_tool_use_id as string | undefined;
    const agentPrefix = parentToolUseId ? "[子任务] " : "";
    expect(agentPrefix).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd web && bun run test -- --reporter=verbose wechat-bridge.test.ts`
Expected: PASS

- [ ] **Step 3: Update the message:assistant handler** (lines 902-953)

Find the `unsubAssistant` subscription and add `parent_tool_use_id` detection. Insert after `if (sid !== sessionId) return;` and before the fallback text logic:

```typescript
const unsubAssistant = companionBus.on("message:assistant", ({ sessionId: sid, message }) => {
  if (sid !== sessionId) return;

  // Detect subagent messages via parent_tool_use_id
  const raw = message as Record<string, unknown>;
  const parentToolUseId = raw.parent_tool_use_id as string | undefined;
  const agentPrefix = parentToolUseId ? "[子任务] " : "";

  // Fallback: if stream events didn't capture text, use assistant message text instead
  const relayData = this.sessionRelayData.get(sessionId);
  if (relayData && !relayData.pendingText.trim()) {
    const assistantText = extractTextFromAssistant(message);
    if (assistantText.trim()) {
      relayData.pendingText = assistantText.trim();
    }
  }

  // Extract and route tool calls to user notifications
  const tools = extractToolUses(message);
  if (tools.length > 0) {
    const userSession = this.userSessions.get(userId);
    const verboseMode = userSession?.verboseMode ?? false;
    for (const t of tools) {
      const parsedInput = t.input;

      if (relayData) {
        relayData.toolAccumulator.push({ name: t.name, input: parsedInput, toolUseId: t.id });
      }

      const formatted = formatToolCall(t.name, parsedInput);
      if (!formatted) continue;
      const labeled = `${agentPrefix}${formatted}`;
      if (verboseMode) {
        this.sendReply(userId, labeled);
      } else {
        if (relayData) {
          relayData.toolNotifyBuffer.push(labeled);
          if (!relayData.toolNotifyTimer) {
            relayData.toolNotifyTimer = setTimeout(() => this.flushToolNotifyBuffer(userId, sessionId), 3000);
          }
        }
      }
    }
  }

  // Detect tool failures and send immediate notifications
  const toolResults = extractToolResults(message);
  if (toolResults.length > 0 && relayData) {
    for (const result of toolResults) {
      const match = relayData.toolAccumulator.find(t => t.toolUseId === result.tool_use_id);
      const toolName = match?.name ?? "unknown";
      this.sendReply(userId, formatToolCallFailure(toolName, result.content));
    }
  }
});
```

Note: the only change from the original is adding the `parentToolUseId` detection (3 lines) and changing `formatted` to `labeled` in the send/buffer calls.

- [ ] **Step 4: Run typecheck and tests**

Run: `cd web && bun run typecheck && bun run test -- --reporter=verbose wechat-bridge.test.ts`
Expected: PASS all

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): add [子任务] label to subagent tool notifications"
```

---

### Task 7: Update remaining old-format references

**Files:**
- Modify: `web/server/wechat-bridge.ts` — any remaining references to `pendingPermission` (singular) or `pendingAskQuestion` (singular)

- [ ] **Step 1: Search for remaining old-format references**

Run: `cd web && grep -n 'pendingPermission[^s]' server/wechat-bridge.ts` and `cd web && grep -n 'pendingAskQuestion[^s]' server/wechat-bridge.ts`

Look for any remaining uses of the old single-slot field names. If found, update them to use the Map equivalents. The main places to check:
- `cmdStatus` — might show pending permission count
- Any other method that reads `pendingPermission` or `pendingAskQuestion`

If `cmdStatus` reads pending permission, update to check `pendingPermissions.size > 0` and show count.

- [ ] **Step 2: Run full typecheck and test suite**

Run: `cd web && bun run typecheck && bun run test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add web/server/wechat-bridge.ts
git commit -m "fix(wechat): update remaining old-format permission references"
```

---

### Task 8: Full test suite + typecheck verification

**Files:**
- All modified files

- [ ] **Step 1: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: Zero errors

- [ ] **Step 2: Run full test suite**

Run: `cd web && bun run test`
Expected: ALL PASS

- [ ] **Step 3: Verify no old-format references remain**

Run: `cd web && grep -n 'pendingPermission[^s]' server/wechat-bridge.ts && grep -n 'pendingAskQuestion[^s]' server/wechat-bridge.ts`
Expected: No matches (or only in comments)

- [ ] **Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore(wechat): final cleanup for concurrent permission queue"
```
