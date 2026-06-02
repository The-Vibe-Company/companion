#!/usr/bin/env bun
/**
 * Audit script for raw protocol recordings.
 *
 * Analyzes JSONL files in ~/.companion/recordings/ and reports:
 * - Message types seen per backend (claude / codex)
 * - Tool input/result field coverage
 * - Gaps between protocol data and what the UI renders
 *
 * Usage:
 *   bun run scripts/audit-recordings.ts                 # all recordings
 *   bun run scripts/audit-recordings.ts --latest        # most recent only
 *   bun run scripts/audit-recordings.ts --session <id>  # specific session
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const latestOnly = args.includes("--latest");
const sessionIdx = args.indexOf("--session");
const sessionFilter = sessionIdx >= 0 ? args[sessionIdx + 1] : null;

// ─── Known UI coverage ─────────────────────────────────────────────────────
// What ToolBlock.tsx currently renders per tool (custom rendering, not JSON dump)

const UI_TOOL_CUSTOM_FIELDS: Record<string, string[]> = {
  Bash: ["command"],
  Read: ["file_path"],
  Edit: ["file_path", "old_string", "new_string"],
  Write: ["file_path", "content"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  WebSearch: ["query"],
};

const UI_PREVIEW_FIELDS: Record<string, string[]> = {
  Bash: ["command"],
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  WebSearch: ["query"],
};

// Message types the browser WS handler has a case for
const BROWSER_HANDLED_TYPES = new Set([
  "session_init", "session_update", "assistant", "stream_event", "result",
  "permission_request", "permission_cancelled", "tool_progress", "tool_use_summary",
  "status_change", "auth_status", "error", "cli_disconnected", "cli_connected",
  "session_name_update", "pr_status_update", "mcp_status", "message_history", "event_replay",
]);

// ─── Types ─────────────────────────────────────────────────────────────────

interface RecordingHeader {
  _header: true;
  version: number;
  session_id: string;
  backend_type: "claude" | "codex";
  started_at: number;
  cwd: string;
}

interface RecordingEntry {
  ts: number;
  dir: "in" | "out";
  raw: string;
  ch: "cli" | "browser";
}

interface ToolInfo {
  inputKeys: Set<string>;
  resultKeys: Set<string>;
  count: number;
}

// ─── Load recordings ───────────────────────────────────────────────────────

const recordingsDir = process.env.COMPANION_RECORDINGS_DIR || join(homedir(), ".companion", "recordings");

let files: string[];
try {
  files = readdirSync(recordingsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(recordingsDir, f));
} catch {
  console.error(`No recordings found at ${recordingsDir}`);
  process.exit(1);
}

if (sessionFilter) {
  files = files.filter((f) => basename(f).startsWith(sessionFilter));
}

if (latestOnly) {
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  files = files.slice(0, 1);
}

if (files.length === 0) {
  console.error("No matching recordings found.");
  process.exit(1);
}

console.log(`\n📁 Analyzing ${files.length} recording(s) from ${recordingsDir}\n`);

// ─── Analyze ───────────────────────────────────────────────────────────────

// Per-backend stats
const backendMessageTypes: Record<string, Record<string, number>> = { claude: {}, codex: {} };
const browserReceivedTypes: Record<string, number> = {};
const toolInfo: Record<string, ToolInfo> = {};
const toolUseResultFields: Record<string, Set<string>> = {};
let totalLines = 0;
let totalFiles = 0;

for (const filePath of files) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) continue;

  let header: RecordingHeader;
  try {
    header = JSON.parse(lines[0]);
    if (!header._header) continue;
  } catch {
    continue;
  }

  totalFiles++;
  totalLines += lines.length - 1;
  const backend = header.backend_type || "unknown";

  for (let i = 1; i < lines.length; i++) {
    let entry: RecordingEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(entry.raw);
    } catch {
      continue;
    }

    // CLI incoming messages (from CLI to server)
    if (entry.ch === "cli" && entry.dir === "in") {
      const type = (raw.type as string) || (raw.method as string) || "rpc_response";
      const stats = backendMessageTypes[backend] || (backendMessageTypes[backend] = {});
      stats[type] = (stats[type] || 0) + 1;

      // Extract tool_use blocks from assistant messages
      if (raw.type === "assistant") {
        const msg = raw.message as Record<string, unknown> | undefined;
        const contentBlocks = (msg?.content as Array<Record<string, unknown>>) || [];
        for (const block of contentBlocks) {
          if (block.type === "tool_use") {
            const toolName = block.name as string;
            if (!toolInfo[toolName]) {
              toolInfo[toolName] = { inputKeys: new Set(), resultKeys: new Set(), count: 0 };
            }
            toolInfo[toolName].count++;
            const input = block.input as Record<string, unknown> | undefined;
            if (input) {
              for (const k of Object.keys(input)) {
                toolInfo[toolName].inputKeys.add(k);
              }
            }
          }
        }
      }

      // Extract tool_use_result from user messages
      if (raw.type === "user") {
        const tur = raw.tool_use_result as Record<string, unknown> | undefined;
        if (tur && typeof tur === "object") {
          const toolName = (tur.tool_name as string) || (tur.type as string) || "unknown";
          if (!toolUseResultFields[toolName]) {
            toolUseResultFields[toolName] = new Set();
          }
          for (const k of Object.keys(tur)) {
            toolUseResultFields[toolName].add(k);
          }
        }
      }

      // Codex JSON-RPC events
      if (raw.method && typeof raw.method === "string") {
        // Already counted above
      }
    }

    // Browser outgoing messages (server to browser)
    if (entry.ch === "browser" && entry.dir === "out") {
      const type = raw.type as string;
      if (type) {
        browserReceivedTypes[type] = (browserReceivedTypes[type] || 0) + 1;
      }
    }
  }
}

// ─── Report ────────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

console.log(`${BOLD}═══ Recording Summary ═══${RESET}`);
console.log(`  Files: ${totalFiles}, Lines: ${totalLines}\n`);

// Per-backend message types
for (const [backend, types] of Object.entries(backendMessageTypes)) {
  const total = Object.values(types).reduce((a, b) => a + b, 0);
  if (total === 0) continue;
  console.log(`${BOLD}═══ ${backend.toUpperCase()} Protocol Messages (${total} total) ═══${RESET}`);
  for (const [type, count] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  console.log();
}

// Browser message coverage
console.log(`${BOLD}═══ Browser Message Coverage ═══${RESET}`);
const unhandled: string[] = [];
for (const [type, count] of Object.entries(browserReceivedTypes).sort((a, b) => b[1] - a[1])) {
  const handled = BROWSER_HANDLED_TYPES.has(type);
  const icon = handled ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${icon} ${type}: ${count}`);
  if (!handled) unhandled.push(type);
}
if (unhandled.length > 0) {
  console.log(`\n  ${RED}Unhandled browser message types: ${unhandled.join(", ")}${RESET}`);
}
console.log();

// Tool coverage
console.log(`${BOLD}═══ Tool Coverage ═══${RESET}`);
const allToolNames = new Set([...Object.keys(toolInfo), ...Object.keys(toolUseResultFields)]);
for (const toolName of [...allToolNames].sort()) {
  const info = toolInfo[toolName];
  const resultFields = toolUseResultFields[toolName];
  const hasCustomUI = toolName in UI_TOOL_CUSTOM_FIELDS;
  const hasPreview = toolName in UI_PREVIEW_FIELDS;

  console.log(`\n  ${BOLD}${toolName}${RESET} ${info ? `(${info.count} calls)` : "(result-only)"}`);

  if (info) {
    const inputKeys = [...info.inputKeys].sort();
    console.log(`    ${CYAN}Input keys:${RESET} ${inputKeys.join(", ")}`);

    if (hasCustomUI) {
      const rendered = UI_TOOL_CUSTOM_FIELDS[toolName];
      const missing = inputKeys.filter((k) => !rendered.includes(k));
      console.log(`    ${GREEN}UI renders:${RESET} ${rendered.join(", ")} (custom)`);
      if (missing.length > 0) {
        console.log(`    ${YELLOW}Not rendered:${RESET} ${missing.join(", ")}`);
      }
    } else {
      console.log(`    ${RED}UI renders:${RESET} JSON.stringify (no custom rendering)`);
    }

    if (!hasPreview) {
      console.log(`    ${YELLOW}No preview${RESET} in collapsed state`);
    }
  }

  if (resultFields) {
    const fields = [...resultFields].sort();
    console.log(`    ${CYAN}Result fields:${RESET} ${fields.join(", ")}`);
    // Highlight interesting fields not surfaced in UI
    const interesting = fields.filter((f) =>
      ["stdout", "stderr", "structuredPatch", "totalDurationMs", "totalTokens",
       "usage", "filePath", "content", "numLines", "originalFile",
       "newTodos", "oldTodos", "status", "interrupted"].includes(f)
    );
    if (interesting.length > 0) {
      console.log(`    ${YELLOW}Rich data available:${RESET} ${interesting.join(", ")}`);
    }
  }
}

console.log(`\n${BOLD}═══ Recommendations ═══${RESET}`);

// Find tools without custom rendering
const noCustom = [...allToolNames].filter((t) => !(t in UI_TOOL_CUSTOM_FIELDS) && toolInfo[t]);
if (noCustom.length > 0) {
  console.log(`\n  ${YELLOW}Tools without custom rendering:${RESET}`);
  for (const t of noCustom.sort()) {
    const keys = toolInfo[t] ? [...toolInfo[t].inputKeys].join(", ") : "?";
    console.log(`    ${t}: could display ${keys}`);
  }
}

// Find tools with rich result data
const richResults = Object.entries(toolUseResultFields).filter(([, fields]) => {
  return [...fields].some((f) =>
    ["stdout", "stderr", "structuredPatch", "totalDurationMs", "usage"].includes(f)
  );
});
if (richResults.length > 0) {
  console.log(`\n  ${YELLOW}Tools with rich result data (not forwarded to browser):${RESET}`);
  for (const [name, fields] of richResults) {
    console.log(`    ${name}: ${[...fields].sort().join(", ")}`);
  }
}

console.log();
