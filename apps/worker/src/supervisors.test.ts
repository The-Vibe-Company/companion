import { describe, expect, it, vi } from "vitest";
import type { Supervisor } from "./billingSupervisor";
import { keepWorkerProcessAliveWhenIdle, startWorkerSupervisors } from "./supervisors";

const supervisor = (): Supervisor => ({ stop: vi.fn(async () => undefined) });

describe("worker supervisor isolation", () => {
  it("starts Skills Hub maintenance when billing is disabled", async () => {
    const skillDatabases = supervisor();
    const result = await startWorkerSupervisors({
      billing: vi.fn(async () => null),
      github: vi.fn(async () => null),
      skillDatabases: vi.fn(async () => skillDatabases),
    });
    expect(result).toEqual({ billing: null, github: null, skillDatabases });
  });

  it("starts Skills Hub maintenance even when billing startup fails", async () => {
    const skillDatabases = supervisor();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await startWorkerSupervisors({
      billing: vi.fn(async () => { throw new Error("billing unavailable"); }),
      github: vi.fn(async () => null),
      skillDatabases: vi.fn(async () => skillDatabases),
    });
    expect(result).toEqual({ billing: null, github: null, skillDatabases });
    expect(error).toHaveBeenCalledWith("billing supervisor failed to start");
    error.mockRestore();
  });

  it("keeps the process alive when every optional supervisor is disabled", () => {
    const idle = keepWorkerProcessAliveWhenIdle({ billing: null });
    try {
      expect(idle).not.toBeNull();
      expect(idle?.hasRef()).toBe(true);
      expect(keepWorkerProcessAliveWhenIdle({ billing: supervisor() })).toBeNull();
    } finally {
      if (idle) clearInterval(idle);
    }
  });
});
