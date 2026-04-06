# WeChat Bot UX: Message Quality Optimization

**Date**: 2026-04-06
**Status**: Approved
**Scope**: `web/server/wechat-bridge.ts`, new file `web/server/wechat-formatter.ts`

## Problem

WeChat Bot 的消息展示存在三个核心问题：

1. **工具调用太技术化** — 用户看到 `🔧 Bash: {"command":"rm -rf ..."}` 这种原始 JSON，难以理解
2. **长回复碎片化** — 超过 4000 字符的消息被粗暴拆分，阅读不连贯
3. **Markdown 格式丢失** — 代码块、列表、表格等在微信中显示混乱

## Solution: Message Formatting Layer

在 `sendReply()` 之前插入一个格式化层，对所有发给用户的消息进行预处理。不改变现有架构，仅优化输出内容。

### New File: `web/server/wechat-formatter.ts`

独立的格式化模块，纯函数，无状态，易于测试。

---

## Part 1: Tool Call Display

### Current Output
```
🔧 Bash: {"command":"rm -rf /tmp/old_logs"}
ℹ️ Tool call in progress
```

### New Output
```
🔧 执行: rm -rf /tmp/old_logs
```

### Tool Type Formatting Map

| Tool | Format | Example |
|------|--------|---------|
| `Bash` | `🔧 执行: {command}` | `🔧 执行: npm test` |
| `Read` | `📖 读取: {file_path}` | `📖 读取: src/index.ts` |
| `Write` | `✏️ 写入: {file_path}` | `✏️ 写入: src/app.ts` |
| `Edit` | `📝 编辑: {file_path}` | `📝 编辑: package.json` |
| `Glob` | `🔍 搜索文件: {pattern}` | `🔍 搜索文件: **/*.test.ts` |
| `Grep` | `🔍 搜索内容: {pattern}` | `🔍 搜索内容: parseCommand` |
| `WebSearch` | `🌐 搜索: {query}` | `🌐 搜索: bun install guide` |
| `Agent` | `🤖 子任务: {description}` | `🤖 子任务: 探索代码库` |
| `TodoWrite` | (不显示) | — |
| 其他 | `🔧 {tool_name}: {简要描述}` | `🔧 MyTool: doing something` |

Implementation:
- Function `formatToolCall(toolName: string, input: Record<string, unknown>): string`
- Extracts the most relevant field per tool type
- Truncates to 200 chars
- Removes `ℹ️ Tool call in progress` suffix (redundant)

---

## Part 2: Markdown to WeChat-Friendly Format

### Conversion Rules

| Markdown | WeChat Output |
|----------|---------------|
| `` ```lang\ncode\n``` `` | Indented block with `│` prefix per line |
| `**bold**` | **bold** (keep as-is, WeChat partial support) |
| `*italic*` | *italic* (keep as-is) |
| `- item` | `• item` |
| `1. item` | `1. item` (keep as-is) |
| `# heading` | `【heading】` |
| `## heading` | `━━ heading ━━` |
| `> quote` | `┃ quote` |
| `[text](url)` | `text (url)` |
| `\| table \|` | Row-by-row, `|` separated |
| `---` | `──────────────` |

### Code Block Formatting
```
Input:
```typescript
function hello() {
  console.log("hi");
}
```

Output:
  │ function hello() {
  │   console.log("hi");
  │ }
```

Implementation:
- Function `formatMarkdown(text: string): string`
- Regex-based conversion, no AST parser needed
- Code blocks detected by fenced markers, content preserved as-is
- Inline markdown handled via simple regex replacements

---

## Part 3: Smart Message Splitting

### Current Behavior
- Split at `\n\n` boundary within 4000 chars
- Fall back to `\n` boundary
- Hard split if neither found
- No continuation indicators

### New Behavior

1. **Priority order for split boundaries**: paragraph (`\n\n`) > newline (`\n`) > hard cut
2. **Code block integrity**: never split inside a fenced code block; find the closing ` ``` ` first
3. **Page indicators**: append `[1/3]` `[2/3]` `[3/3]` when splitting into multiple messages
4. **Minimum chunk size**: if a chunk would be < 200 chars, merge with the next one

Implementation:
- Replace existing `splitForWeChat()` function
- Function `splitForWeChat(text: string): string[]`
- Returns array of chunks, each ≤ 4000 chars including page indicator

---

## Part 4: Permission Request Formatting

### Current Output
```
⚠️ Permission needed:
Tool: Bash
Description: Execute command
Input: {"command":"rm -rf /tmp/old_logs"}

Send /y (allow) or /n (deny)
```

### New Output
```
⚠️ 需要批准操作:

执行命令:
rm -rf /tmp/old_logs

回复 /y 批准 / /n 拒绝
```

### Per-Tool Permission Display

| Tool | Display |
|------|---------|
| `Bash` | `执行命令:\n{command}` |
| `Write` | `写入文件: {file_path}\n内容预览: {content 前 200 字符}` |
| `Edit` | `编辑文件: {file_path}\n替换: {old_text 前 100 字符} → {new_text 前 100 字符}` |
| `Agent` | `子任务: {description 或 prompt 前 200 字符}` |
| 其他 | `{tool_name}: {description 或 input 前 200 字符}` |

Implementation:
- Function `formatPermissionRequest(toolName: string, input: Record<string, unknown>, description?: string): string`
- Same tool-type logic as Part 1 but with more context for permission decisions

---

## Part 5: Tool Execution Summary

### Current Behavior
Each tool call sends a separate message:
```
🔧 Bash: {"command":"npm install"}
ℹ️ Tool call in progress
🔧 Read: {"file_path":"src/index.ts"}
ℹ️ Tool call in progress
```

### New Behavior
**Suppress individual `ℹ️ Tool call in progress` notifications** (redundant). Auto-approve notifications (`✅ Auto-approved`) are kept but reformatted via Part 1 rules. Instead of per-tool messages, send a single summary at the end of each assistant turn (when `message:result` fires):

```
📊 本轮: 读取 3 个文件 · 编辑 1 个文件 · 运行 1 个命令
```

Implementation:
- Accumulate tool calls in `sessionRelayData` during the turn
- On `message:result`, generate summary from accumulated data
- Group by tool type and count
- Display format: `📊 本轮: {verb} {count} 个 {noun} · {verb} {count} 个 {noun}`
- If only 1-2 safe tools (auto-approved), skip the summary (too noisy)

### Tool Verb Mapping

| Tool Type | Verb | Noun |
|-----------|------|------|
| Read | 读取 | 文件 |
| Write | 写入 | 文件 |
| Edit | 编辑 | 文件 |
| Bash | 运行 | 命令 |
| Glob | 搜索 | 文件 |
| Grep | 搜索 | 内容 |
| WebSearch | 搜索 | 网页 |
| Agent | 派发 | 子任务 |
| 其他 | 执行 | 操作 |

---

## Part 6: Progress Indicator

### Current Behavior
- Typing indicator throttled to every 5 seconds
- No text feedback during long operations

### New Behavior
During streaming, if no content has been sent to the user for > 15 seconds (indicating a long tool-use chain), send a brief status:

```
⏳ 正在处理... (已执行 3 个操作)
```

This replaces the current individual `🔧 tool call` messages. Only sent when the turn is taking a long time (>15s) and no text has been delivered yet.

Implementation:
- Track `lastUserFacingMessageTs` in `sessionRelayData`
- In the `message:stream_event` handler, check elapsed time
- Send progress update only when: elapsed > 15s AND no text sent AND tool count > 0

---

## Implementation Notes

### File Changes

1. **New**: `web/server/wechat-formatter.ts` (~150 lines)
   - `formatToolCall()`
   - `formatPermissionRequest()`
   - `formatMarkdown()`
   - `splitForWeChat()` (replace existing)
   - `formatToolSummary()`

2. **New**: `web/server/wechat-formatter.test.ts` (~200 lines)
   - Unit tests for all formatting functions
   - Edge cases: empty input, very long strings, mixed markdown, nested code blocks

3. **Modified**: `web/server/wechat-bridge.ts`
   - Import formatter functions
   - Replace `splitForWeChat()` with imported version
   - Replace inline tool call formatting in `message:assistant` handler with `formatToolCall()`
   - Replace inline permission formatting in `handlePermissionRequest()` with `formatPermissionRequest()`
   - Replace `(operation completed)` with contextual message
   - Add tool accumulation + summary in `message:result` handler
   - Add progress indicator logic in `message:stream_event` handler

### Backward Compatibility
- All formatting is output-only; no protocol or data structure changes
- Existing commands and message flow unchanged
- Safe tools auto-approve notifications still work (now with cleaner format)

### Testing Strategy
- Unit tests for all `wechat-formatter.ts` functions (pure functions, easy to test)
- Update existing `wechat-bridge.test.ts` for new message relay behavior
- Manual testing with real WeChat bot for visual verification
