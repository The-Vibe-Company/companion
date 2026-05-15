#!/usr/bin/env bun
/**
 * Spike #2: verify the bidirectional control protocol works over stdio.
 *
 * The user-message round-trip (spike-stdio-protocol.ts) only proves the
 * happy path. Companion's interactive features depend on `control_request`
 * (permission gates, mcp_status, set_model, interrupt). This spike asks
 * Claude to do something that requires a permission gate, then captures
 * what flows when companion would normally answer with control_response.
 *
 * Trick: don't pass `--permission-mode bypassPermissions`. Instead use
 * `default`, ask Claude to run a Bash tool. The CLI should emit a
 * `control_request` with subtype `can_use_tool`. We respond with allow,
 * see whether the Bash actually runs, and dump everything.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = [
  "--print",
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode", "default",
  "-p", "",
];

const outDir = mkdtempSync(join(tmpdir(), "stdio-spike-control-"));
console.log(`[spike] dump dir: ${outDir}`);

const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });

const lines: string[] = [];
const types: Record<string, number> = {};
const subtypes = new Set<string>();
let stderrBuf = "";
let buf = "";
let pendingPermissionId: string | null = null;
let answered = false;

proc.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    lines.push(line);
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      types["<parse-error>"] = (types["<parse-error>"] ?? 0) + 1;
      continue;
    }
    const t = String(obj.type ?? "<no-type>");
    types[t] = (types[t] ?? 0) + 1;
    const subtypeRaw =
      (obj as { subtype?: string }).subtype
      ?? ((obj as { request?: { subtype?: string } }).request?.subtype);
    if (subtypeRaw) subtypes.add(`${t}/${subtypeRaw}`);
    console.log(`  → ${t}${subtypeRaw ? `/${subtypeRaw}` : ""}`);

    // Answer control_request[can_use_tool] with allow, exactly the way
    // the bridge does today (claude-adapter.ts handleIncomingControlRequest).
    if (
      t === "control_request"
      && (obj as { request?: { subtype?: string } }).request?.subtype === "can_use_tool"
    ) {
      const reqId = String((obj as { request_id?: string }).request_id ?? "");
      const req = (obj as { request: { tool_name?: string; input?: unknown } }).request;
      pendingPermissionId = reqId;
      console.log(`     tool=${req.tool_name} input=${JSON.stringify(req.input).slice(0, 80)}`);
      const response = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: { behavior: "allow", updatedInput: req.input ?? {} },
        },
      });
      proc.stdin.write(response + "\n");
      console.log(`  ← control_response/allow (request_id=${reqId.slice(0, 8)}…)`);
      answered = true;
    }
  }
});

proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });

proc.on("exit", (code, signal) => {
  writeFileSync(join(outDir, "stdout.ndjson"), lines.join("\n") + (lines.length ? "\n" : ""));
  writeFileSync(join(outDir, "stderr.txt"), stderrBuf);
  console.log(`\n[spike] exit code=${code} signal=${signal ?? "none"}`);
  console.log(`[spike] type histogram:`);
  for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log(`         ${String(v).padStart(4)}  ${k}`);
  }
  console.log(`[spike] subtypes seen : ${[...subtypes].sort().join(", ")}`);
  console.log(`[spike] permission asked: ${pendingPermissionId ? "yes" : "no"}`);
  console.log(`[spike] permission answered: ${answered}`);
  console.log(`[spike] stdout lines : ${lines.length} → ${join(outDir, "stdout.ndjson")}`);
  console.log(`[spike] stderr bytes : ${stderrBuf.length} → ${join(outDir, "stderr.txt")}`);
});

// Ask Claude to do something that requires a tool gate.
const userMsg = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content:
      "Run the Bash tool with this exact command: `echo PONG-${RANDOM}`. "
      + "Do not explain. After it succeeds, reply with the literal output you saw.",
  },
  parent_tool_use_id: null,
  session_id: "",
});
proc.stdin.write(userMsg + "\n");
proc.stdin.end();

// Hard timeout — do not let the spike hang forever in CI/local.
setTimeout(() => {
  console.error("[spike] timeout — killing process");
  proc.kill("SIGKILL");
}, 90_000);
