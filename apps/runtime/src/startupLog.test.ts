import { describe, expect, it } from "vitest";

import { RuntimeDatabaseRoleError } from "./database";
import {
  handleRuntimeStartupFailure,
  logRuntimeStartupFailure,
  shouldCaptureRuntimeStartupFailure,
  type RuntimeStartupFailureEffects,
} from "./startupLog";

describe("runtime startup failure logs", () => {
  it("prints the thrown cause instead of a generic startup line", () => {
    const lines: string[] = [];
    logRuntimeStartupFailure(
      new Error("Box runtime is not configured; set COMPANION_BOX_API_KEY"),
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    // SAFETY: logRuntimeStartupFailure always serializes one JSON object through the process logger.
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      event?: string;
      thrown?: { message?: string };
    };
    expect(parsed.event).toBe("runtime.startup.failed");
    expect(parsed.thrown?.message).toContain("COMPANION_BOX_API_KEY");
    expect(lines[0]).not.toBe("runtime failed to start");
  });

  it("keeps a role-readiness refusal in the fatal startup log instead of handled Sentry reporting", () => {
    const lines: string[] = [];
    const error = new RuntimeDatabaseRoleError("release_schema_incomplete");

    logRuntimeStartupFailure(error, (line) => lines.push(line));

    expect(shouldCaptureRuntimeStartupFailure(error)).toBe(false);
    expect(shouldCaptureRuntimeStartupFailure(new Error("unexpected startup failure"))).toBe(true);
    expect(lines).toHaveLength(1);
    // SAFETY: logRuntimeStartupFailure always serializes one JSON object through the process logger.
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      thrown?: { message?: string; stableCode?: string };
    };
    expect(parsed.thrown?.message).toContain("apply its migrations and runtime grants");
    expect(parsed.thrown?.stableCode).toBe("runtime_database_role_release_schema_incomplete");
  });

  it.each([
    {
      name: "role-readiness refusal",
      error: new RuntimeDatabaseRoleError("release_schema_incomplete"),
      expectedEvents: ["log", "exit:1"],
    },
    {
      name: "unexpected startup failure",
      error: new Error("unexpected startup failure"),
      expectedEvents: ["log", "exit:1", "capture", "flush"],
    },
  ])("applies the process-boundary reporting policy for a $name", async ({ error, expectedEvents }) => {
    const events: string[] = [];
    const effects: RuntimeStartupFailureEffects = {
      capture: (captured) => {
        expect(captured).toBe(error);
        events.push("capture");
      },
      flush: async () => {
        events.push("flush");
      },
      log: (logged) => {
        expect(logged).toBe(error);
        events.push("log");
      },
      setExitCode: (code) => {
        events.push(`exit:${code}`);
      },
    };

    await handleRuntimeStartupFailure(error, effects);

    expect(events).toEqual(expectedEvents);
  });
});
