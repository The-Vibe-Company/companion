import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSnapshot(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function extractAliasBody(tsSource: string, alias: string): string {
  const match = tsSource.match(new RegExp(`export declare type ${alias} = \\{([\\s\\S]*?)\\n\\};`));
  return match?.[1] || "";
}

describe("Claude protocol compatibility (offline Agent SDK snapshot)", () => {
  it("includes all Claude message categories used by the bridge", () => {
    const sdk = readSnapshot("server/protocol/claude-upstream/sdk.d.ts.txt");

    expect(sdk).toContain("export declare type SDKAssistantMessage = {");
    expect(sdk).toContain("type: 'assistant';");

    expect(sdk).toContain("export declare type SDKPartialAssistantMessage = {");
    expect(sdk).toContain("type: 'stream_event';");

    expect(sdk).toContain("export declare type SDKResultSuccess = {");
    expect(sdk).toContain("export declare type SDKResultError = {");
    expect(sdk).toContain("type: 'result';");

    expect(sdk).toContain("export declare type SDKToolProgressMessage = {");
    expect(sdk).toContain("type: 'tool_progress';");

    expect(sdk).toContain("export declare type SDKToolUseSummaryMessage = {");
    expect(sdk).toContain("type: 'tool_use_summary';");

    expect(sdk).toContain("export declare type SDKAuthStatusMessage = {");
    expect(sdk).toContain("type: 'auth_status';");

    expect(sdk).toContain("export declare type SDKUserMessage = {");
    expect(sdk).toContain("type: 'user';");
  });

  it("keeps system init/status subtypes expected by ws-bridge", () => {
    const sdk = readSnapshot("server/protocol/claude-upstream/sdk.d.ts.txt");

    const systemInitBody = extractAliasBody(sdk, "SDKSystemMessage");
    expect(systemInitBody).toContain("type: 'system';");
    expect(systemInitBody).toContain("subtype: 'init';");

    const systemStatusBody = extractAliasBody(sdk, "SDKStatusMessage");
    expect(systemStatusBody).toContain("type: 'system';");
    expect(systemStatusBody).toContain("subtype: 'status';");
  });

  it("keeps result and tool fields required by the UI", () => {
    const sdk = readSnapshot("server/protocol/claude-upstream/sdk.d.ts.txt");

    const resultSuccessBody = extractAliasBody(sdk, "SDKResultSuccess");
    for (const field of ["duration_ms", "num_turns", "total_cost_usd", "stop_reason", "usage", "modelUsage"]) {
      expect(resultSuccessBody).toContain(`${field}:`);
    }

    const toolProgressBody = extractAliasBody(sdk, "SDKToolProgressMessage");
    for (const field of ["tool_use_id", "tool_name", "elapsed_time_seconds"]) {
      expect(toolProgressBody).toContain(`${field}:`);
    }

    const userBody = extractAliasBody(sdk, "SDKUserMessage");
    for (const field of ["message", "parent_tool_use_id", "session_id"]) {
      expect(userBody).toContain(`${field}:`);
    }
  });
});
