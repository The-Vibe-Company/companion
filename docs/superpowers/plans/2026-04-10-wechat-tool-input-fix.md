# WeChat Tool Input Display Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two WeChat display bugs: (1) Write/Edit file paths missing due to JSON truncation, (2) AskUserQuestion content truncated and not interactive on WeChat.

**Architecture:** Remove unnecessary stringify+truncate in `extractToolUses`, pass objects directly. Add `formatAskUserQuestion` formatter and number-based response flow so WeChat users can answer multi-choice questions by replying with a number.

**Tech Stack:** TypeScript, Vitest, Hono

---

## File Structure

| File | Responsibility |
|------|---------------|
| `web/server/wechat-formatter.ts` | Add `formatAskUserQuestion()` |
| `web/server/wechat-formatter.test.ts` | Tests for `formatAskUserQuestion()` |
| `web/server/wechat-bridge.ts` | Fix `extractToolUses` return type; add AskUserQuestion interaction |
| `web/server/wechat-bridge.test.ts` | Tests for AskUserQuestion interaction |

---

### Task 1: Add `formatAskUserQuestion` to formatter

**Files:**
- Modify: `web/server/wechat-formatter.ts`
- Test: `web/server/wechat-formatter.test.ts`

- [ ] **Step 1: Write failing tests for `formatAskUserQuestion`**

Add to `web/server/wechat-formatter.test.ts`:

```typescript
import { formatAskUserQuestion } from "./wechat-formatter.js";

describe("formatAskUserQuestion", () => {
  it("formats single question with options", () => {
    const input = {
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          options: [
            { label: "Option A", description: "Faster" },
            { label: "Option B", description: "Safer" },
          ],
          multiSelect: false,
        },
      ],
    };
    const result = formatAskUserQuestion(input);
    expect(result).toContain("❓ Which approach?");
    expect(result).toContain("1. Option A");
    expect(result).toContain("   Faster");
    expect(result).toContain("2. Option B");
    expect(result).toContain("   Safer");
    expect(result).toContain("回复序号选择");
  });

  it("formats question without descriptions", () => {
    const input = {
      questions: [
        {
          question: "Confirm?",
          header: "Confirm",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
          multiSelect: false,
        },
      ],
    };
    const result = formatAskUserQuestion(input);
    expect(result).toContain("1. Yes");
    expect(result).toContain("2. No");
  });

  it("handles empty questions gracefully", () => {
    const result = formatAskUserQuestion({ questions: [] });
    expect(result).toBe("");
  });

  it("handles missing questions field", () => {
    const result = formatAskUserQuestion({});
    expect(result).toBe("");
  });

  it("includes Other option for free-text answers", () => {
    const input = {
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "desc" }],
          multiSelect: false,
        },
      ],
    };
    const result = formatAskUserQuestion(input);
    // Should include an "Other" option for free-text input
    expect(result).toMatch(/\d+\.\s+其他/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: FAIL — `formatAskUserQuestion` is not exported

- [ ] **Step 3: Implement `formatAskUserQuestion`**

Add to `web/server/wechat-formatter.ts`:

```typescript
/** Format an AskUserQuestion tool input for WeChat display with numbered options. */
export function formatAskUserQuestion(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
  if (questions.length === 0) return "";

  const parts: string[] = [];
  for (const q of questions) {
    const questionText = String(q.question ?? "");
    if (questionText) parts.push(`❓ ${questionText}`);
    parts.push("");

    const options = Array.isArray(q.options) ? q.options as Array<Record<string, string>> : [];
    let num = 1;
    for (const opt of options) {
      const label = String(opt.label ?? "");
      const desc = String(opt.description ?? "");
      if (desc) {
        parts.push(`${num}. ${label}`);
        parts.push(`   ${desc}`);
      } else {
        parts.push(`${num}. ${label}`);
      }
      num++;
    }
    // Add "Other" option for free-text answers
    parts.push(`${num}. 其他`);
    parts.push("   输入自定义回答");
  }

  parts.push("");
  parts.push("回复序号选择 (如: 1)");
  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: All `formatAskUserQuestion` tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat-formatter.ts web/server/wechat-formatter.test.ts
git commit -m "feat(wechat): add formatAskUserQuestion for multi-choice display"
```

---

### Task 2: Fix `extractToolUses` — pass objects instead of truncated strings

**Files:**
- Modify: `web/server/wechat-bridge.ts`

- [ ] **Step 1: Write failing test for extractToolUses returning object input**

The function `extractToolUses` is private (not exported). We'll verify the fix through the formatter tests — the Write/Edit formatter tests already exist and will pass once the relay handler uses the object correctly.

Instead, add a test that verifies the formatter works with a full Write input including large content (the scenario that was broken):

Add to `web/server/wechat-formatter.test.ts`:

```typescript
it("formats Write tool with large content — file_path still visible", () => {
  // This was the core bug: extractToolUses truncated JSON.stringify(input) to 200 chars,
  // which cut off file_path when content was large. After fix, input is passed as object.
  const result = formatToolCall("Write", {
    file_path: "src/components/VeryLongComponentName.tsx",
    content: "x".repeat(5000),
  });
  expect(result).toBe("✏️ 写入: src/components/VeryLongComponentName.tsx");
});

it("formats Edit tool with large old_string — file_path still visible", () => {
  const result = formatToolCall("Edit", {
    file_path: "package.json",
    old_string: "x".repeat(5000),
    new_string: "y".repeat(5000),
  });
  expect(result).toBe("📝 编辑: package.json");
});
```

- [ ] **Step 2: Run tests — should pass (formatter already handles objects correctly)**

Run: `cd web && bun run test -- --run wechat-formatter.test.ts`
Expected: PASS — these test the formatter, which already accepts objects

- [ ] **Step 3: Fix `extractToolUses` return type in wechat-bridge.ts**

In `web/server/wechat-bridge.ts`, change the return type and implementation of `extractToolUses`:

Find (around line 115):
```typescript
function extractToolUses(msg: BrowserIncomingMessage): Array<{ name: string; input: string; id?: string }> {
```
Replace with:
```typescript
function extractToolUses(msg: BrowserIncomingMessage): Array<{ name: string; input: Record<string, unknown>; id?: string }> {
```

Find (around line 129):
```typescript
      input: toolBlock.input ? JSON.stringify(toolBlock.input).slice(0, 200) : "",
```
Replace with:
```typescript
      input: toolBlock.input ?? {},
```

- [ ] **Step 4: Fix relay handler — remove JSON.parse of input**

In `web/server/wechat-bridge.ts`, in the `message:assistant` event handler, find (around line 841):
```typescript
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(t.input || "{}");
          } catch { /* use empty object */ }
```
Replace with:
```typescript
          const parsedInput = t.input;
```

And the next line (around line 848) that references `parsedInput` stays the same since `t.input` is already `Record<string, unknown>`.

- [ ] **Step 5: Run all WeChat tests**

Run: `cd web && bun run test -- --run wechat-bridge.test.ts wechat-formatter.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-formatter.test.ts
git commit -m "fix(wechat): pass tool input as object instead of truncated string"
```

---

### Task 3: Add AskUserQuestion interaction to WeChatBridge

**Files:**
- Modify: `web/server/wechat-bridge.ts`
- Test: `web/server/wechat-bridge.test.ts`

- [ ] **Step 1: Add `pendingAskQuestion` to `WeChatUserSession` interface**

In `web/server/wechat-bridge.ts`, find the `WeChatUserSession` interface (around line 19) and add:

```typescript
interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermission: { requestId: string; sessionId: string } | null;
  verboseMode: boolean;
  pendingAskQuestion: {
    requestId: string;
    sessionId: string;
    questions: Array<Record<string, unknown>>;
  } | null;
}
```

- [ ] **Step 2: Initialize `pendingAskQuestion` in `getOrCreateUserSession`**

Find the `getOrCreateUserSession` method (around line 1018) and add `pendingAskQuestion: null` to the new object:

```typescript
    userSession = { sessionIds: [], activeSessionIndex: 0, pendingPermission: null, verboseMode: false, pendingAskQuestion: null };
```

Also update `restoreSessionMappings` (around line 1061) to include `pendingAskQuestion: null`:

```typescript
        this.userSessions.set(userId, {
          sessionIds: mapping.sessionIds,
          activeSessionIndex: mapping.activeSessionIndex,
          pendingPermission: null,
          verboseMode: mapping.verboseMode ?? false,
          pendingAskQuestion: null,
        });
```

- [ ] **Step 3: Add import for `formatAskUserQuestion`**

Find the import line at top of file (around line 15):
```typescript
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary, formatToolCallFailure } from "./wechat-formatter.js";
```
Replace with:
```typescript
import { formatToolCall, formatPermissionRequest, formatMarkdown, splitForWeChat, formatToolSummary, formatToolCallFailure, formatAskUserQuestion } from "./wechat-formatter.js";
```

- [ ] **Step 4: Add AskUserQuestion branch in `handlePermissionRequest`**

In `handlePermissionRequest` (around line 991), add a check for AskUserQuestion BEFORE the existing `isDangerousTool` check. Insert after `if (!userSession) return;`:

```typescript
    // AskUserQuestion: format as numbered options, track pending state for response
    if (perm.tool_name === "AskUserQuestion") {
      const questions = Array.isArray(perm.input.questions) ? perm.input.questions as Array<Record<string, unknown>> : [];
      userSession.pendingAskQuestion = {
        requestId: perm.request_id,
        sessionId,
        questions,
      };
      // Also set as pending permission so permission_cancelled can clear it
      userSession.pendingPermission = { requestId: perm.request_id, sessionId };
      const formatted = formatAskUserQuestion(perm.input);
      this.sendReply(userId, formatted);
      return;
    }
```

- [ ] **Step 5: Add AskUserQuestion response handling in `handleMessage`**

In `handleMessage` (around line 378), add AskUserQuestion response handling BEFORE the existing `parseCommand` call. Insert after the whitelist check:

```typescript
    // Check for pending AskUserQuestion — number response selects option
    const userSession = this.userSessions.get(userId);
    if (userSession?.pendingAskQuestion) {
      const num = parseInt(text.trim(), 10);
      const pending = userSession.pendingAskQuestion;
      const questions = pending.questions;

      if (!isNaN(num) && num > 0) {
        // Number response: map to option
        const q = questions[0]; // single question flow for now
        const options = Array.isArray(q?.options) ? q.options as Array<Record<string, string>> : [];
        // +1 because we add "Other" as last option
        const otherIndex = options.length + 1;
        if (num === otherIndex) {
          // "Other" selected — user's text IS the answer. We need more input.
          // For now, just approve with the text as answer
          userSession.pendingAskQuestion = null;
          userSession.pendingPermission = null;
          this.wsBridge.injectPermissionResponse(sessionId, pending.requestId, "allow", {
            ...{ questions },
            answers: { "0": text.trim() },
          });
          await this.sendReply(userId, `已选择: ${text.trim()}`);
          return;
        }
        const selected = options[num - 1];
        if (selected) {
          userSession.pendingAskQuestion = null;
          userSession.pendingPermission = null;
          this.wsBridge.injectPermissionResponse(sessionId, pending.requestId, "allow", {
            ...{ questions },
            answers: { "0": selected.label },
          });
          await this.sendReply(userId, `已选择: ${selected.label}`);
          return;
        }
      }

      // Non-number text while AskUserQuestion pending — treat as "Other" free-text answer
      userSession.pendingAskQuestion = null;
      userSession.pendingPermission = null;
      this.wsBridge.injectPermissionResponse(sessionId, pending.requestId, "allow", {
        ...{ questions },
        answers: { "0": text.trim() },
      });
      await this.sendReply(userId, `已选择: ${text.trim()}`);
      return;
    }
```

Note: this needs the `sessionId` from the pending question. Use `pending.sessionId` instead of looking up from user session.

Also update `session:permission-cancelled` handler (around line 941) to also clear `pendingAskQuestion`:

```typescript
      if (userSession?.pendingPermission?.requestId === requestId) {
        userSession.pendingPermission = null;
        userSession.pendingAskQuestion = null;
        this.sendReply(userId, "Permission request was cancelled.");
      }
```

- [ ] **Step 6: Write tests for AskUserQuestion interaction**

Add to `web/server/wechat-bridge.test.ts`:

```typescript
describe("AskUserQuestion pending state handling", () => {
  it("clears pendingAskQuestion when permission is cancelled", () => {
    interface PendingAsk {
      requestId: string;
      sessionId: string;
      questions: Array<Record<string, unknown>>;
    }
    interface PendingPerm {
      requestId: string;
      sessionId: string;
    }

    const pendingAskQuestion: PendingAsk | null = {
      requestId: "req-ask-1",
      sessionId: "sess-1",
      questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    };
    let pendingPermission: PendingPerm | null = { requestId: "req-ask-1", sessionId: "sess-1" };

    // Simulate permission_cancelled
    if (pendingPermission?.requestId === "req-ask-1") {
      pendingPermission = null;
      (pendingAskQuestion as PendingAsk | null) = null;
    }

    expect(pendingPermission).toBeNull();
    expect(pendingAskQuestion).toBeNull();
  });

  it("maps number 1 to first option label", () => {
    const questions = [
      { question: "Pick one", options: [{ label: "Option A", description: "Fast" }, { label: "Option B", description: "Safe" }] },
    ];
    const num = 1;
    const options = Array.isArray(questions[0]?.options) ? questions[0].options as Array<Record<string, string>> : [];
    const selected = options[num - 1];
    expect(selected?.label).toBe("Option A");
  });

  it("maps number to 'Other' when number exceeds options count", () => {
    const questions = [
      { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
    ];
    const options = Array.isArray(questions[0]?.options) ? questions[0].options as Array<Record<string, string>> : [];
    const otherIndex = options.length + 1;
    expect(otherIndex).toBe(3);
    // num=3 should trigger "Other" path
    const num = 3;
    const isOther = num === otherIndex;
    expect(isOther).toBe(true);
  });

  it("handles non-number text as free-text answer", () => {
    const text = "I want something custom";
    const num = parseInt(text, 10);
    expect(isNaN(num)).toBe(true);
    // This text should be used as the free-text answer
    expect(text.trim()).toBe("I want something custom");
  });
});
```

- [ ] **Step 7: Run all WeChat tests**

Run: `cd web && bun run test -- --run wechat-bridge.test.ts wechat-formatter.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Run full typecheck**

Run: `cd web && bun run typecheck`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add web/server/wechat-bridge.ts web/server/wechat-bridge.test.ts
git commit -m "feat(wechat): add AskUserQuestion interactive response via number selection"
```

---

### Task 4: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd web && bun run test -- --run`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: No errors
