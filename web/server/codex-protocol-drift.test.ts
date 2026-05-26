import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function extractMethods(tsSource: string): Set<string> {
  return new Set([...tsSource.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]));
}

function extractCaseMethods(source: string, start: string, end: string): Set<string> {
  const afterStart = source.split(start)[1];
  if (!afterStart) return new Set();
  const block = afterStart.split(end)[0] || "";
  return new Set([...block.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
}

describe("Codex adapter method drift vs upstream protocol snapshot", () => {
  it("keeps handled methods aligned with the upstream protocol (or explicit legacy allowlist)", () => {
    const adapter = readFile("server/codex-adapter.ts");

    const handledNotifications = extractCaseMethods(
      adapter,
      "private handleNotification(method: string, params: Record<string, unknown>): void {",
      "private handleRequest(method: string, id: JsonRpcId, params: Record<string, unknown>): void {",
    );

    const handledRequests = extractCaseMethods(
      adapter,
      "private handleRequest(method: string, id: JsonRpcId, params: Record<string, unknown>): void {",
      "private handleCommandApproval(jsonRpcId: JsonRpcId, params: Record<string, unknown>): void {",
    );

    const calledClientMethods = new Set(
      [...adapter.matchAll(/this\.transport\.(?:call|notify)\("([^"]+)"/g)].map((m) => m[1]),
    );

    const upstreamServerNotifications = extractMethods(readFile("server/protocol/codex-upstream/ServerNotification.ts.txt"));
    const upstreamServerRequests = extractMethods(readFile("server/protocol/codex-upstream/ServerRequest.ts.txt"));
    const upstreamClientRequests = extractMethods(readFile("server/protocol/codex-upstream/ClientRequest.ts.txt"));
    const upstreamClientNotifications = extractMethods(readFile("server/protocol/codex-upstream/ClientNotification.ts.txt"));

    const legacyNotifications = new Set([
      "item/updated",
      // Legacy/alternate delta envelope still observed in some runs.
      "item/delta",
      // Legacy alias still observed in recordings; upstream snapshot currently
      // models the same payload under item/reasoning/textDelta.
      "item/reasoning/delta",
      // Status notification observed in production logs but not yet present in
      // the pinned upstream snapshot files.
      "thread/status/changed",
      "codex/event/stream_error",
      "codex/event/error",
      "codex/event/token_count",
      "codex/event/agent_message_delta",
      "codex/event/agent_message_content_delta",
      "codex/event/reasoning_content_delta",
      "codex/event/agent_message",
      "codex/event/item_started",
      "codex/event/item_completed",
      "codex/event/exec_command_begin",
      "codex/event/exec_command_output_delta",
      "codex/event/exec_command_end",
      "codex/event/turn_diff",
      "codex/event/terminal_interaction",
      "codex/event/patch_apply_begin",
      "codex/event/patch_apply_end",
      "codex/event/user_message",
      "codex/event/task_started",
      "codex/event/task_complete",
      "codex/event/mcp_startup_complete",
      "codex/event/context_compacted",
      "codex/event/agent_reasoning",
      "codex/event/agent_reasoning_delta",
      "codex/event/agent_reasoning_section_break",
      // Bare "error" notification for transient stream disconnections.
      "error",
      // Per-server MCP startup progress updates.
      "mcpServer/startupStatus/updated",
      // Context compaction event (v2 form of codex/event/context_compacted).
      "thread/compacted",
      // Legacy realtime transcript notification shape still seen in some runs.
      "thread/realtime/transcriptUpdated",
      // Informational warnings from Codex runtime.
      "configWarning",
      "deprecationNotice",
      "codex/event/deprecation_notice",
      // Legacy event variants for MCP startup, turn abort, image viewing, web search.
      "codex/event/mcp_startup_update",
      "codex/event/turn_aborted",
      "codex/event/view_image_tool_call",
      "codex/event/web_search_begin",
      "codex/event/web_search_end",
      // Companion-internal notification emitted by codex-ws-proxy.cjs on
      // WebSocket reconnection — not part of the upstream Codex protocol.
      "companion/wsReconnected",
    ]);

    const legacyServerRequests = new Set([
      "item/mcpToolCall/requestApproval",
    ]);

    for (const method of handledNotifications) {
      expect(
        upstreamServerNotifications.has(method) || legacyNotifications.has(method),
        `Unhandled by upstream snapshot (notification): ${method}`,
      ).toBe(true);
    }

    for (const method of handledRequests) {
      expect(
        upstreamServerRequests.has(method) || legacyServerRequests.has(method),
        `Unhandled by upstream snapshot (server request): ${method}`,
      ).toBe(true);
    }

    for (const method of calledClientMethods) {
      expect(
        upstreamClientRequests.has(method) || upstreamClientNotifications.has(method),
        `Unhandled by upstream snapshot (client method): ${method}`,
      ).toBe(true);
    }
  });
});
