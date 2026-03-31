// @vitest-environment node
import { describe, test, expect } from "vitest";
import {
  LAUNCH_CONFIG_JSON_SCHEMA,
  LAUNCH_CONFIG_EXAMPLE,
  buildLaunchSchemaResponse,
} from "./launch-config-schema.js";
import { validateConfig } from "./launch-config.js";

describe("launch-config-schema", () => {
  test("JSON Schema has required top-level structure", () => {
    expect(LAUNCH_CONFIG_JSON_SCHEMA.type).toBe("object");
    expect(LAUNCH_CONFIG_JSON_SCHEMA.required).toContain("version");
    expect(LAUNCH_CONFIG_JSON_SCHEMA.properties).toHaveProperty("version");
    expect(LAUNCH_CONFIG_JSON_SCHEMA.properties).toHaveProperty("setup");
    expect(LAUNCH_CONFIG_JSON_SCHEMA.properties).toHaveProperty("services");
    expect(LAUNCH_CONFIG_JSON_SCHEMA.properties).toHaveProperty("ports");
  });

  test("JSON Schema defines conditions in $defs", () => {
    expect(LAUNCH_CONFIG_JSON_SCHEMA.$defs).toHaveProperty("conditions");
    const conditions = LAUNCH_CONFIG_JSON_SCHEMA.$defs.conditions;
    expect(conditions.properties).toHaveProperty("local");
    expect(conditions.properties).toHaveProperty("sandbox");
    expect(conditions.properties).toHaveProperty("worktree");
  });

  test("example passes runtime validateConfig()", () => {
    // This catches drift between the schema example and the actual validation logic
    const result = validateConfig(LAUNCH_CONFIG_EXAMPLE);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("buildLaunchSchemaResponse() returns a string with schema and example", () => {
    const response = buildLaunchSchemaResponse();
    expect(typeof response).toBe("string");
    // Should contain the schema
    expect(response).toContain("JSON Schema");
    expect(response).toContain('"version"');
    // Should contain the example
    expect(response).toContain("Complete Example");
    expect(response).toContain("install-deps");
    // Should contain key concepts
    expect(response).toContain("Key Concepts");
    expect(response).toContain("dependsOn");
    // Should reference the validation tools
    expect(response).toContain("validate_launch_config");
    expect(response).toContain("test_launch_config");
  });
});
