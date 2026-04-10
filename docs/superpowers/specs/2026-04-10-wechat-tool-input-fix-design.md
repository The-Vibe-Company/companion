# WeChat Tool Input Display Fix

**Date**: 2026-04-10
**Status**: Approved

## Problem

Two issues in the WeChat bot bridge:

### 1. Write/Edit file path missing

When Claude Code uses Write or Edit tools, the WeChat notification shows `✏️ 写入: ` or `📝 编辑: ` with nothing after the colon — the file path is blank.

**Root cause**: `extractToolUses()` (wechat-bridge.ts:129) stringifies the tool input object and truncates to 200 chars:

```typescript
input: toolBlock.input ? JSON.stringify(toolBlock.input).slice(0, 200) : ""
```

For Write/Edit, the input contains large fields (`content`, `old_string`, `new_string`). The truncated string is invalid JSON, so the later `JSON.parse()` fails, `parsedInput` becomes `{}`, and `file_path` is undefined.

### 2. AskUserQuestion not interactive on WeChat

When Claude Code uses AskUserQuestion, the WeChat user sees truncated JSON and can only respond with `/y` or `/n` — there's no way to select an option.

**Root cause**: No special formatting in `formatToolCall` or `formatPermissionRequest` for AskUserQuestion. Falls into default branch which stringifies and truncates the input. The `/y`/`/n` response model doesn't support multi-choice selection.

## Design

### Fix 1: Pass original input objects in extractToolUses

**File**: `web/server/wechat-bridge.ts`

Change `extractToolUses()` return type from `input: string` to `input: Record<string, unknown>`. Pass the original input object directly — no stringify, no truncate.

```typescript
// Before
.map((toolBlock) => ({
  name: toolBlock.name,
  input: toolBlock.input ? JSON.stringify(toolBlock.input).slice(0, 200) : "",
  id: ...,
}))

// After
.map((toolBlock) => ({
  name: toolBlock.name,
  input: toolBlock.input ?? {},
  id: ...,
}))
```

In the relay handler (companionBus `message:assistant`), remove the `JSON.parse(t.input)` try/catch and use `t.input` directly since it's already an object.

### Fix 2: AskUserQuestion WeChat formatting and interaction

**File**: `web/server/wechat-formatter.ts`

Add `formatAskUserQuestion()` function that renders questions with numbered options:

```
❓ Which approach do you prefer?

1. Option A
   Faster but less accurate
2. Option B
   Slower but more precise
3. Other
   Type your own answer

回复序号选择 (如: 1)
```

**File**: `web/server/wechat-bridge.ts`

1. Add `pendingAskQuestion` field to `WeChatUserSession` to track pending AskUserQuestion state (questions + request_id).
2. In `handlePermissionRequest()`, add AskUserQuestion branch:
   - Format questions via `formatAskUserQuestion()`
   - Store questions in `pendingAskQuestion`
   - Send formatted text to WeChat
3. In `handleMessage()` / `handleCommand()`, check `pendingAskQuestion`:
   - If a pending question exists and user sends a number, map it to the selected option
   - Send the selected option label as the permission response
   - Clear `pendingAskQuestion`
   - If user sends text that's not a number, forward it as "Other" free-text answer

## Files to modify

| File | Changes |
|------|---------|
| `web/server/wechat-bridge.ts` | Fix `extractToolUses` return type; add AskUserQuestion interaction in `handlePermissionRequest` and `handleMessage` |
| `web/server/wechat-formatter.ts` | Add `formatAskUserQuestion()` |
| `web/server/wechat-formatter.test.ts` | Tests for `formatAskUserQuestion` |
| `web/server/wechat-bridge.test.ts` | Update tests for new `extractToolUses` return type; add AskUserQuestion interaction tests |
