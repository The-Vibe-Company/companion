import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function extractCaseMethods(source: string, start: string, end: string): Set<string> {
  const afterStart = source.split(start)[1];
  if (!afterStart) return new Set();
  const block = afterStart.split(end)[0] || "";
  return new Set([...block.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
}

function extractTypeLiterals(tsSource: string): Set<string> {
  return new Set([...tsSource.matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1]));
}

describe("Claude ws-bridge method drift vs upstream Agent SDK snapshot", () => {
  /**
   * CLI message routing now lives in claude-adapter.ts (ClaudeAdapter.handleRawMessage).
   * This test verifies that the adapter handles all upstream CLI message types.
   */
  it("keeps handled CLI message types aligned with upstream (or explicit local allowlist)", () => {
    const adapter = readFile("server/claude-adapter.ts");
    const sdk = readFile("server/protocol/claude-upstream/sdk.d.ts.txt");

    // Extract case "xxx": from the routeCLIMessage switch in claude-adapter.ts
    const handledFromCLI = extractCaseMethods(
      adapter,
      "private routeCLIMessage(msg: CLIMessage): void {",
      "// -- System message handling",
    );
    expect(handledFromCLI.size).toBeGreaterThan(0);

    const upstreamMessageTypes = extractTypeLiterals(sdk);

    // Messages we intentionally support in raw CLI transport but are not part of SDKMessage union.
    // - control_request / keep_alive: core transport types not in SDK
    // - user: CLI echoes back user messages (including subagent tool_result blocks)
    // - rate_limit_event: Claude API rate-limit status (allowed/throttled)
    // - control_cancel_request: cancels a pending control_request (v2.1.81+)
    // - streamlined_text / streamlined_tool_use_summary: simplified output mode (@internal, v2.1.81+)
    // - prompt_suggestion: predicted next user prompts (v2.1.81+)
    const localRawTransportTypes = new Set([
      "control_request", "keep_alive", "user", "rate_limit_event",
      "control_cancel_request", "streamlined_text", "streamlined_tool_use_summary", "prompt_suggestion",
    ]);

    for (const method of handledFromCLI) {
      expect(
        upstreamMessageTypes.has(method) || localRawTransportTypes.has(method),
        `Unhandled by upstream snapshot (CLI message type): ${method}`,
      ).toBe(true);
    }
  });

  /**
   * System subtypes (init, status) are now handled in claude-adapter.ts
   * instead of ws-bridge.ts. This test verifies they are still present.
   */
  it("keeps system subtypes handled by ws-bridge aligned with upstream", () => {
    const adapter = readFile("server/claude-adapter.ts");
    const sdk = readFile("server/protocol/claude-upstream/sdk.d.ts.txt");

    const upstreamInit = sdk.includes("export declare type SDKSystemMessage = {")
      && sdk.includes("subtype: 'init';");
    const upstreamStatus = sdk.includes("export declare type SDKStatusMessage = {")
      && sdk.includes("subtype: 'status';");

    expect(upstreamInit).toBe(true);
    expect(upstreamStatus).toBe(true);

    expect(adapter).toContain('if (msg.subtype === "init")');
    expect(adapter).toContain('if (msg.subtype === "status")');
  });
});
