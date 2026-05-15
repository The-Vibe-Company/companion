import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

describe("paths", () => {
  const originalEnv = process.env.AGENTHANGAR_HOME;

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.AGENTHANGAR_HOME;
    } else {
      process.env.AGENTHANGAR_HOME = originalEnv;
    }
  });

  it("defaults to ~/.agenthangar/ when AGENTHANGAR_HOME is not set", async () => {
    delete process.env.AGENTHANGAR_HOME;
    // Dynamic import to pick up env change (module is already cached, so we
    // test the value computed at import time — which uses the env at startup)
    const { AGENTHANGAR_HOME } = await import("./paths.js");
    // When env var is unset at module load time, it should be ~/.agenthangar
    expect(AGENTHANGAR_HOME).toBe(join(homedir(), ".agenthangar"));
  });

  it("exports a string path", async () => {
    const { AGENTHANGAR_HOME } = await import("./paths.js");
    expect(typeof AGENTHANGAR_HOME).toBe("string");
    expect(AGENTHANGAR_HOME.length).toBeGreaterThan(0);
  });
});
