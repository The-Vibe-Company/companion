#!/usr/bin/env bun
/**
 * Spike: verify claude headless stdio NDJSON ≡ current --sdk-url WS NDJSON.
 *
 * Spawns `claude` with the same flags companion uses today, MINUS `--sdk-url`,
 * so the CLI's NDJSON flows over stdin/stdout instead of a WebSocket. Sends
 * one canned user message and dumps every line stdout emits, plus stderr,
 * until the CLI exits.
 *
 * Compare the resulting type histogram against a recent recording under
 * ~/.companion/recordings/<id>_claude_*.jsonl (filter `ch=cli`) to confirm
 * the protocol is transport-agnostic.
 *
 * Usage: bun web/scripts/spike-stdio-protocol.ts [prompt]
 *   default prompt is "Reply with the literal string 'pong' and nothing else."
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROMPT =
  process.argv[2]
  ?? "Reply with the literal string 'pong' and nothing else.";

const args = [
  // NOTE: no --sdk-url. That is the entire point of the spike.
  "--print",
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode", "bypassPermissions",
  "-p", "",
];

const outDir = mkdtempSync(join(tmpdir(), "stdio-spike-"));
const outFile = join(outDir, "stdout.ndjson");
const errFile = join(outDir, "stderr.txt");

console.log(`[spike] spawning: claude ${args.join(" ")}`);
console.log(`[spike] dump dir : ${outDir}`);

const proc = spawn("claude", args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const types: Record<string, number> = {};
const lines: string[] = [];
let stderrBuf = "";
let buf = "";

proc.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    lines.push(line);
    try {
      const obj = JSON.parse(line) as { type?: string; subtype?: string };
      const k = obj.type ?? "<no-type>";
      types[k] = (types[k] ?? 0) + 1;
      // log a one-line summary as events arrive
      const subtype = (obj as { subtype?: string }).subtype
        ?? ((obj as { request?: { subtype?: string } }).request?.subtype);
      console.log(`  → ${k}${subtype ? `/${subtype}` : ""}`);
    } catch (err) {
      types["<parse-error>"] = (types["<parse-error>"] ?? 0) + 1;
      console.log(`  → <parse-error>: ${(err as Error).message}: ${line.slice(0, 120)}`);
    }
  }
});

proc.stderr.on("data", (chunk: Buffer) => {
  stderrBuf += chunk.toString("utf8");
});

proc.on("error", (err) => {
  console.error("[spike] spawn error:", err);
  process.exit(2);
});

proc.on("exit", (code, signal) => {
  writeFileSync(outFile, lines.join("\n") + (lines.length ? "\n" : ""));
  writeFileSync(errFile, stderrBuf);
  console.log(`\n[spike] exit code=${code} signal=${signal ?? "none"}`);
  console.log(`[spike] type histogram:`);
  for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log(`         ${String(v).padStart(4)}  ${k}`);
  }
  console.log(`[spike] stdout lines : ${lines.length} → ${outFile}`);
  console.log(`[spike] stderr bytes : ${stderrBuf.length} → ${errFile}`);
});

// Mimic exactly what claude-adapter.ts:299-304 builds when companion sends
// a user_message over WS. Ship one prompt, then close stdin so the CLI
// finishes the turn and exits cleanly.
const userMsg = JSON.stringify({
  type: "user",
  message: { role: "user", content: PROMPT },
  parent_tool_use_id: null,
  session_id: "",
});
console.log(`[spike] writing user message: ${PROMPT}`);
proc.stdin.write(userMsg + "\n");
proc.stdin.end();
