import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSnapshot(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function extractMethods(tsSource: string): string[] {
  const methods = [...tsSource.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]);
  return Array.from(new Set(methods));
}

describe("Codex protocol compatibility (offline snapshot)", () => {
  it("includes all Codex notifications handled by codex-adapter", () => {
    const serverNotification = readSnapshot("server/protocol/codex-upstream/ServerNotification.ts.txt");
    const methods = extractMethods(serverNotification);

    for (const method of [
      "item/started",
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/mcpToolCall/progress",
      "item/plan/delta",
      "item/completed",
      "rawResponseItem/completed",
      "turn/started",
      "turn/completed",
      "turn/plan/updated",
      "turn/diff/updated",
      "thread/started",
      "thread/status/changed",
      "thread/tokenUsage/updated",
      "thread/goal/updated",
      "thread/goal/cleared",
      "serverRequest/resolved",
      "command/exec/outputDelta",
      "hook/started",
      "hook/completed",
      "account/updated",
      "account/rateLimits/updated",
      "account/login/completed",
      "warning",
      "guardianWarning",
    ]) {
      expect(methods).toContain(method);
    }
  });

  it("includes all client methods used by codex-adapter", () => {
    const clientRequest = readSnapshot("server/protocol/codex-upstream/ClientRequest.ts.txt");
    const methods = extractMethods(clientRequest);

    for (const method of [
      "initialize",
      "thread/start",
      "thread/resume",
      "turn/start",
      "turn/interrupt",
      "account/rateLimits/read",
    ]) {
      expect(methods).toContain(method);
    }
  });

  it("includes the client initialized notification used by codex-adapter", () => {
    const clientNotification = readSnapshot("server/protocol/codex-upstream/ClientNotification.ts.txt");
    const methods = extractMethods(clientNotification);
    expect(methods).toContain("initialized");
  });

  it("includes all server requests handled by codex-adapter", () => {
    const serverRequest = readSnapshot("server/protocol/codex-upstream/ServerRequest.ts.txt");
    const methods = extractMethods(serverRequest);

    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/permissions/requestApproval",
      "item/tool/call",
      "applyPatchApproval",
      "execCommandApproval",
      "attestation/generate",
      "account/chatgptAuthTokens/refresh",
    ]) {
      expect(methods).toContain(method);
    }
  });

  it("keeps DynamicToolCallParams shape expected by the adapter", () => {
    const paramsType = readSnapshot("server/protocol/codex-upstream/v2/DynamicToolCallParams.ts.txt");
    for (const field of ["threadId", "turnId", "callId", "tool", "arguments"]) {
      expect(paramsType).toContain(`${field}:`);
    }
  });

  it("keeps DynamicToolCallResponse shape expected by the adapter", () => {
    const responseType = readSnapshot("server/protocol/codex-upstream/v2/DynamicToolCallResponse.ts.txt");
    expect(responseType).toContain("contentItems:");
    expect(responseType).toContain("success: boolean");
  });
});
