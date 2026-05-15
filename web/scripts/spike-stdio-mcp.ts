#!/usr/bin/env bun
/**
 * Spike #3: prove companion→CLI control_request round-trips via stdio.
 *
 * `mcp_get_status` is the cleanest probe: companion sends a
 * control_request{subtype:mcp_status}, CLI must reply with a
 * control_response carrying mcpServers. Same handler companion uses today
 * (claude-adapter.ts handleOutgoingMcpGetStatus → handleIncomingControlResponse).
 * If this works, set_model / set_permission_mode / interrupt all work too —
 * same envelope, different subtype.
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
  "--permission-mode", "bypassPermissions",
  "-p", "",
];

const outDir = mkdtempSync(join(tmpdir(), "stdio-spike-mcp-"));
console.log(`[spike] dump dir: ${outDir}`);

const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const lines: string[] = [];
const types: Record<string, number> = {};
let stderrBuf = "";
let buf = "";
let mcpRequestId: string | null = null;
let gotMcpResponse = false;

proc.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    lines.push(line);
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { continue; }
    const t = String(obj.type ?? "<no-type>");
    types[t] = (types[t] ?? 0) + 1;

    if (t === "control_response") {
      const resp = (obj as { response?: { request_id?: string; subtype?: string; response?: unknown } }).response;
      console.log(`  ← control_response/${resp?.subtype} request_id=${(resp?.request_id ?? "").slice(0, 8)}…`);
      if (resp?.request_id === mcpRequestId) {
        gotMcpResponse = true;
        const mcpResp = resp.response as { mcpServers?: unknown[] } | undefined;
        const servers = mcpResp?.mcpServers ?? [];
        console.log(`     mcpServers count = ${Array.isArray(servers) ? servers.length : "?"}`);
        // Got what we wanted — close stdin so CLI exits cleanly.
        proc.stdin.end();
      }
    } else if (t === "system" || t === "result") {
      const subtype = (obj as { subtype?: string }).subtype;
      console.log(`  → ${t}/${subtype}`);
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
  console.log(`[spike] mcp_status round-trip: ${gotMcpResponse ? "✅ OK" : "❌ FAILED"}`);
  console.log(`[spike] stdout lines : ${lines.length} → ${join(outDir, "stdout.ndjson")}`);
});

// Wait briefly for system/init, then send the control_request just like
// claude-adapter.ts:383 handleOutgoingMcpGetStatus does today.
setTimeout(() => {
  mcpRequestId = randomUUID();
  const req = JSON.stringify({
    type: "control_request",
    request_id: mcpRequestId,
    request: { subtype: "mcp_status" },
  });
  console.log(`  → control_request/mcp_status request_id=${mcpRequestId.slice(0, 8)}…`);
  proc.stdin.write(req + "\n");
}, 500);

setTimeout(() => {
  console.error("[spike] timeout — killing");
  proc.kill("SIGKILL");
}, 30_000);
