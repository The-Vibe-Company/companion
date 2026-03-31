// @vitest-environment node
import { describe, test, expect } from "vitest";
import { buildCompanionMcpPrompt } from "./mcp-prompt-builder.js";

describe("mcp-prompt-builder", () => {
  test("prompt mentions all five MCP tool names", () => {
    const prompt = buildCompanionMcpPrompt();
    expect(prompt).toContain("get_launch_config_schema");
    expect(prompt).toContain("validate_launch_config");
    expect(prompt).toContain("test_launch_config");
    expect(prompt).toContain("reload_launch_config");
    expect(prompt).toContain("get_session_environment_status");
  });

  test("prompt is a non-empty string", () => {
    const prompt = buildCompanionMcpPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(50);
  });

  test("prompt includes workflow guidance", () => {
    const prompt = buildCompanionMcpPrompt();
    // Should describe the step-by-step workflow
    expect(prompt).toContain("get_launch_config_schema");
    expect(prompt).toContain("validate_launch_config");
    expect(prompt).toContain("Workflow");
  });
});
