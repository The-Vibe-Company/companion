# WeChat Tool Execution Progress Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push real-time tool execution summaries to WeChat so users can see what the AI is doing during execution, with batch/verbose mode toggle and failure notifications.

**Architecture:** Modify the existing `message:assistant` handler in `wechat-bridge.ts` to route tool calls through a batch buffer with a 3-second flush timer. Add `/verbose` command for per-message mode. Detect tool failures via `tool_result` content blocks. Remove the old 15-second progress indicator.

**Tech Stack:** TypeScript, Vitest, Node.js timers

---

### Task 1: Add `formatToolCallFailure` to formatter (TDD)

**Files:**
- Modify: `web/server/wechat-formatter.ts` (append after line 258)
- Test: `web/server/wechat-formatter.test.ts` (append at end)

- [ ] **Step 1: Write failing tests for `formatToolCallFailure`**

Add to the import at top of `web/server/wechat-formatter.test.ts`:

```typescript
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary, formatToolCallFailure } from "./wechat-formatter.js";
```

Append to `web/server/wechat-formatter.test.ts`:

```typescript
describe("formatToolCallFailure", () => {
  it("formats a tool failure with truncated content", () => {
    const result = formatToolCallFailure("Bash", "Error: command failed with exit code 1");
    expect(result).toBe("❌ 失败: Bash\nError: command failed with exit code 1");
  });

  it("truncates long error content to 300 chars", () => {
    const longError = "x".repeat(500);
    const result = formatToolCallFailure("Bash", longError);
    expect(result.length).toBeLessThan(350);
    expect(result).toContain("❌ 失败: Bash\n");
    expect(result).toEndWith("...");
  });

  it("handles empty content", () => {
    const result = formatToolCallFailure("Bash", "");
    expect(result).toBe("❌ 失败: Bash\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/king/Documents/the-companion-dev/web && bun run test --run server/wechat-formatter.test.ts`
Expected: FAIL — `formatToolCallFailure` is not exported

- [ ] **Step 3: Implement `formatToolCallFailure`**

Append to `web/server/wechat-formatter.ts` after the `formatToolSummary` function (after line 258):

```typescript
/** Format a tool execution failure for WeChat display. */
export function formatToolCallFailure(toolName: string, content: string): string {
  return `❌ 失败: ${toolName}\n${truncate(content, 300)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/king/Documents/the-companion-dev/web && bun run test --run server/wechat-formatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-formatter.ts web/server/wechat-formatter.test.ts
git commit -m "feat(wechat): add formatToolCallFailure for tool error notifications"
```

---

### Task 2: Add `extractToolResults` helper to bridge (TDD)

**Files:**
- Modify: `web/server/wechat-bridge.ts` (append after `extractToolUses`, line ~128)
- Test: `web/server/wechat-bridge.test.ts` (append at end)

- [ ] **Step 1: Write failing test for `extractToolResults`**

Add to the import at top of `web/server/wechat-bridge.test.ts`:

```typescript
import { parseCommand, isDangerousTool, extractToolResults } from "./wechat-bridge.js";
```

Append to `web/server/wechat-bridge.test.ts`:

```typescript
describe("extractToolResults", () => {
  it("extracts error tool_result blocks from assistant message", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "command failed", is_error: true },
          { type: "tool_result", tool_use_id: "tu_2", content: "success output", is_error: false },
        ],
      },
    };
    const results = extractToolResults(msg as any);
    expect(results).toEqual([
      { tool_use_id: "tu_1", content: "command failed", is_error: true },
    ]);
  });

  it("returns empty array for non-assistant message", () => {
    const msg = { type: "user", message: { content: "hello" } };
    const results = extractToolResults(msg as any);
    expect(results).toEqual([]);
  });

  it("returns empty array when no tool_result blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "thinking..." },
        ],
      },
    };
    const results = extractToolResults(msg as any);
    expect(results).toEqual([]);
  });

  it("ignores non-error tool_result blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_ok", content: "success", is_error: false },
        ],
      },
    };
    const results = extractToolResults(msg as any);
    expect(results).toHaveLength(0);
  });

  it("handles content as array", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_arr",
            content: [{ type: "text", text: "file not found" }],
            is_error: true,
          },
        ],
      },
    };
    const results = extractToolResults(msg as any);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("file not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/king/Documents/the-companion-dev/web && bun run test --run server/wechat-bridge.test.ts`
Expected: FAIL — `extractToolResults` is not exported

- [ ] **Step 3: Implement `extractToolResults`**

Add to `web/server/wechat-bridge.ts` after the `extractToolUses` function (after line 128). It must be exported:

```typescript
/** Extract tool_result blocks (errors only) from assistant message content. */
export function extractToolResults(msg: BrowserIncomingMessage): Array<{ tool_use_id: string; content: string; is_error: boolean }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; tool_use_id: string; content: string; is_error: boolean } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_result"
      && typeof (b as Record<string, unknown>).tool_use_id === "string"
      && (b as Record<string, unknown>).is_error === true)
    .map((b) => ({
      tool_use_id: b.tool_use_id,
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      is_error: true,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/king/Documents/the-companion-dev/web && bun run test --run server/wechat-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): add extractToolResults for detecting tool failures"
```

---

### Task 3: Update types and `extractToolUses` to include `id`

**Files:**
- Modify: `web/server/wechat-bridge.ts`

This task only changes the type signatures and `extractToolUses`. The handler rewrite happens in Task 4.

- [ ] **Step 1: Update `extractToolUses` return type to include `id`**

In `web/server/wechat-bridge.ts`, modify `extractToolUses` (lines 112-128). The tool_use content blocks have an `id` field that serves as `tool_use_id`:

```typescript
/** Extract tool use blocks from assistant message */
function extractToolUses(msg: BrowserIncomingMessage): Array<{ name: string; input: string; id?: string }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; name: string; input?: Record<string, unknown>; id?: string } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_use"
      && typeof (b as Record<string, unknown>).name === "string")
    .map((toolBlock) => ({
      name: toolBlock.name,
      input: toolBlock.input ? JSON.stringify(toolBlock.input).slice(0, 200) : "",
      id: (toolBlock as Record<string, unknown>).id as string | undefined,
    }));
}
```

- [ ] **Step 2: Update `sessionRelayData` type**

In `wechat-bridge.ts` line 148, change the `toolAccumulator` type to include `toolUseId`:

```typescript
toolAccumulator: Array<{ name: string; input: Record<string, unknown>; toolUseId?: string }>;
```

- [ ] **Step 3: Add new relay data fields**

In `wechat-bridge.ts` line 142-151, add the new fields to the type. The full updated type:

```typescript
  private sessionRelayData = new Map<string, {
    pendingText: string;
    lastTypingTs: number;
    streamlinedSent: boolean;
    contentSent: boolean;
    lastBlockIndex: number;
    toolAccumulator: Array<{ name: string; input: Record<string, unknown>; toolUseId?: string }>;
    lastUserFacingMessageTs: number;
    progressSent: boolean;
    toolNotifyBuffer: string[];
    toolNotifyTimer: ReturnType<typeof setTimeout> | null;
  }>();
```

- [ ] **Step 4: Update `ensureRelay` initialization**

In `wechat-bridge.ts` line 722, update the initialization to include new fields:

```typescript
this.sessionRelayData.set(sessionId, { pendingText: "", lastTypingTs: 0, streamlinedSent: false, contentSent: false, lastBlockIndex: -1, toolAccumulator: [], lastUserFacingMessageTs: Date.now(), progressSent: false, toolNotifyBuffer: [], toolNotifyTimer: null });
```

- [ ] **Step 5: Run tests to verify nothing broke**

Run: `cd /Users/king/Documents/the-companion-dev/web && bun run test --run server/wechat-bridge.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/server/wechat-bridge.ts
git commit -m "feat(wechat): update types for tool_use_id tracking and batch buffer"
```

---

### Task 4: Rewrite `message:assistant` handler with batch buffer and failure detection

**Files:**
- Modify: `web/server/wechat-bridge.ts`

This is the core change: un-suppress tool calls, route through batch buffer, detect failures, clean up old progress indicator.

- [ ] **Step 1: Add `formatToolCallFailure` to the import**

In `wechat-bridge.ts` line 15, update the import:

```typescript
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary, formatToolCallFailure } from "./wechat-formatter.js";
```

- [ ] **Step 2: Add `flushToolNotifyBuffer` method**

Add a new private method to the `WeChatBridge` class after `cleanupRelay` (around line 917):

```typescript
  /** Flush pending tool notification buffer to WeChat. */
  private flushToolNotifyBuffer(userId: string, sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (!relayData || relayData.toolNotifyBuffer.length === 0) return;
    const merged = relayData.toolNotifyBuffer.join("\n");
    relayData.toolNotifyBuffer = [];
    relayData.toolNotifyTimer = null;
    this.sendReply(userId, merged);
  }
```

- [ ] **Step 3: Rewrite the `message:assistant` handler**

Replace the existing `message:assistant` handler (lines 791-817) with the following. This un-suppresses tool calls, routes them through batch/verbose mode, and detects failures:

```typescript
    // Assistant messages — extract tool uses; use text as fallback if stream events missed it
    const unsubAssistant = companionBus.on("message:assistant", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;

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
          // Parse input safely for accumulator and display
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(t.input || "{}");
          } catch { /* use empty object */ }

          if (relayData) {
            relayData.toolAccumulator.push({ name: t.name, input: parsedInput, toolUseId: t.id });
          }

          // Route tool call to user notification
          const formatted = formatToolCall(t.name, parsedInput);
          if (!formatted) continue; // suppressed tools (TodoWrite, etc.)
          if (verboseMode) {
            this.sendReply(userId, formatted);
          } else {
            if (relayData) {
              relayData.toolNotifyBuffer.push(formatted);
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
          // Find matching tool name from accumulator
          const match = relayData.toolAccumulator.find(t => t.toolUseId === result.tool_use_id);
          const toolName = match?.name ?? "unknown";
          this.sendReply(userId, formatToolCallFailure(toolName, result.content));
        }
      }
    });
```

- [ ] **Step 4: Remove the 15-second progress indicator from `message:stream_event`**

In `wechat-bridge.ts` around lines 749-758, delete the `progressSent` block entirely (the `if (!relayData.progressSent) { ... }` block inside the stream_event handler). Also remove the `progressSent` reference in `message:result` (around line 874).

- [ ] **Step 5: Remove tool summary from `message:result` handler**

In `wechat-bridge.ts` around lines 856-860, delete the tool summary block:

```typescript
// DELETE THIS:
if (relayData && relayData.toolAccumulator.length > 0 && (streamText.trim() || hadContent)) {
  const summary = formatToolSummary(relayData.toolAccumulator);
  if (summary) this.sendReply(userId, summary);
}
```

- [ ] **Step 6: Add timer cleanup to `cleanupRelay`**

Replace the existing `cleanupRelay` method (line 910):

```typescript
  private cleanupRelay(sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (relayData?.toolNotifyTimer) {
      clearTimeout(relayData.toolNotifyTimer);
    }
    const cleanups = this.sessionCleanups.get(sessionId);
    if (cleanups) {
      for (const cleanup of cleanups) cleanup();
      this.sessionCleanups.delete(sessionId);
    }
    this.sessionRelayData.delete(sessionId);
  }
```

- [ ] **Step 7: Run all tests**

Run: `cd /Users/king/Documents/the-companion-dev/web && bun run test --run server/wechat-bridge.test.ts server/wechat-formatter.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add web/server/wechat-bridge.ts
git commit -m "feat(wechat): add batch buffered tool notifications with failure detection"
```

---

### Task 5: Add `/verbose` command and persistence

**Files:**
- Modify: `web/server/wechat-bridge.ts`

- [ ] **Step 1: Update `WeChatUserSession` interface**

In `wechat-bridge.ts` lines 19-23, add `verboseMode`:

```typescript
interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermission: { requestId: string; sessionId: string } | null;
  verboseMode: boolean;
}
```

- [ ] **Step 2: Add `/verbose` to HELP_TEXT**

Update `HELP_TEXT` (lines 48-64) to add:

```typescript
const HELP_TEXT = `Companion WeChat Bot Commands:

/new [folder] — Create a new session (optionally in a subfolder)
/sessions — List your sessions
/switch <n> — Switch to session #n
/kill — Kill active session
/model <name> — Switch model
/mode <mode> — Set permission mode
/allow (or /y) — Approve pending permission
/deny (or /n) — Deny pending permission
/interrupt — Cancel current operation
/status — Show session status
/dir [path] — List folders in default directory
/verbose — Toggle tool notification mode (batch/verbose)
/help — Show this help

Other /commands (e.g. /compact, /clear) are forwarded to Claude Code.
Plain text is also sent to the active session.`;
```

- [ ] **Step 3: Add `/verbose` to `handleCommand` switch**

In `handleCommand` (around line 438), add before `default:`:

```typescript
      case "verbose":
        await this.cmdVerbose(userId);
        break;
```

- [ ] **Step 4: Implement `cmdVerbose` method**

Add after `cmdDir` method (around line 681):

```typescript
  private async cmdVerbose(userId: string): Promise<void> {
    const userSession = this.getOrCreateUserSession(userId);
    userSession.verboseMode = !userSession.verboseMode;
    this.persistSessionMappings();
    if (userSession.verboseMode) {
      await this.sendReply(userId, "🔔 已切换到逐条模式 — 每个操作即时推送");
    } else {
      await this.sendReply(userId, "🔕 已切换到批量模式 — 操作每3秒合并推送");
    }
  }
```

- [ ] **Step 5: Extend `/status` to show notification mode**

In `cmdStatus` (around line 640), add before the `await this.sendReply` line:

```typescript
      `工具通知: ${userSession.verboseMode ? "逐条" : "批量"}`,
```

Note: `userSession` needs to be available in `cmdStatus`. Currently `cmdStatus` gets `userSession` via `this.userSessions.get(userId)`. Verify it exists; if not, add:

```typescript
const userSession = this.userSessions.get(userId);
```

- [ ] **Step 6: Update `getOrCreateUserSession`**

In `wechat-bridge.ts` (line 951-957), update to include `verboseMode`:

```typescript
  private getOrCreateUserSession(userId: string): WeChatUserSession {
    let userSession = this.userSessions.get(userId);
    if (!userSession) {
      userSession = { sessionIds: [], activeSessionIndex: 0, pendingPermission: null, verboseMode: false };
      this.userSessions.set(userId, userSession);
    }
    return userSession;
  }
```

- [ ] **Step 7: Update persistence**

Update `PersistedMapping` interface (around line 27):

```typescript
interface PersistedMapping {
  sessionIds: string[];
  activeSessionIndex: number;
  verboseMode?: boolean;
}
```

Update `restoreSessionMappings` (around line 993) to read `verboseMode`:

```typescript
        this.userSessions.set(userId, {
          sessionIds: mapping.sessionIds,
          activeSessionIndex: mapping.activeSessionIndex,
          pendingPermission: null,
          verboseMode: mapping.verboseMode ?? false,
        });
```

Update `persistSessionMappings` (around line 1011) to write `verboseMode`:

```typescript
        data[userId] = {
          sessionIds: userSession.sessionIds,
          activeSessionIndex: userSession.activeSessionIndex,
          verboseMode: userSession.verboseMode,
        };
```

- [ ] **Step 8: Run all tests**

Run: `cd /Users/king/Documents/the-companion-dev/web && bun run test --run server/wechat-bridge.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add web/server/wechat-bridge.ts
git commit -m "feat(wechat): add /verbose command with persistent preference"
```

---

### Task 6: Run full test suite and verify

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/king/Documents/the-companion-dev && bun run test`
Expected: All tests pass (5070+ tests)

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/king/Documents/the-companion-dev && bun run typecheck`
Expected: No new errors (3 pre-existing errors in `sandbox-routes.test.ts` and `skills-routes.test.ts` are acceptable)

- [ ] **Step 3: Fix any issues and commit**
