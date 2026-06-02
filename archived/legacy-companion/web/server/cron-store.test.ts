import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let cronStore: typeof import("./cron-store.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cron-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  cronStore = await import("./cron-store.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function cronDir(): string {
  return join(tempDir, ".companion", "cron");
}

function makeJobInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Job",
    prompt: "Do something useful",
    schedule: "0 8 * * *",
    recurring: true,
    backendType: "claude" as const,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/test-repo",
    enabled: true,
    permissionMode: "bypassPermissions",
    ...overrides,
  };
}

// ===========================================================================
// Slugification (tested indirectly via createJob)
// ===========================================================================
describe("slugification via createJob", () => {
  it("converts spaces to hyphens and lowercases", () => {
    const job = cronStore.createJob(makeJobInput({ name: "My Daily Task" }));
    expect(job.id).toBe("my-daily-task");
  });

  it("strips special characters", () => {
    const job = cronStore.createJob(makeJobInput({ name: "Check PRs! @#$%" }));
    expect(job.id).toBe("check-prs");
  });

  it("collapses consecutive hyphens", () => {
    const job = cronStore.createJob(makeJobInput({ name: "a   ---  b" }));
    expect(job.id).toBe("a-b");
  });

  it("throws when name is empty string", () => {
    expect(() => cronStore.createJob(makeJobInput({ name: "" }))).toThrow("Job name is required");
  });

  it("throws when name is only whitespace", () => {
    expect(() => cronStore.createJob(makeJobInput({ name: "   " }))).toThrow("Job name is required");
  });

  it("throws when name contains no alphanumeric characters", () => {
    expect(() => cronStore.createJob(makeJobInput({ name: "@#$%^&" }))).toThrow(
      "Job name must contain alphanumeric characters",
    );
  });
});

// ===========================================================================
// listJobs
// ===========================================================================
describe("listJobs", () => {
  it("returns empty array when no jobs exist", () => {
    expect(cronStore.listJobs()).toEqual([]);
  });

  it("returns jobs sorted alphabetically by name", () => {
    cronStore.createJob(makeJobInput({ name: "Zebra Task" }));
    cronStore.createJob(makeJobInput({ name: "Alpha Task" }));
    cronStore.createJob(makeJobInput({ name: "Mango Task" }));

    const result = cronStore.listJobs();
    expect(result.map((j) => j.name)).toEqual(["Alpha Task", "Mango Task", "Zebra Task"]);
  });

  it("skips corrupt JSON files", () => {
    cronStore.createJob(makeJobInput({ name: "Valid Job" }));
    writeFileSync(join(cronDir(), "corrupt.json"), "NOT VALID JSON{{{", "utf-8");

    const result = cronStore.listJobs();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Valid Job");
  });
});

// ===========================================================================
// getJob
// ===========================================================================
describe("getJob", () => {
  it("returns the job when it exists", () => {
    cronStore.createJob(makeJobInput({ name: "My Job" }));

    const result = cronStore.getJob("my-job");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Job");
    expect(result!.id).toBe("my-job");
    expect(result!.prompt).toBe("Do something useful");
  });

  it("returns null when the job does not exist", () => {
    expect(cronStore.getJob("nonexistent")).toBeNull();
  });
});

// ===========================================================================
// createJob
// ===========================================================================
describe("createJob", () => {
  it("returns a job with correct structure and timestamps", () => {
    const before = Date.now();
    const job = cronStore.createJob(makeJobInput());
    const after = Date.now();

    expect(job.name).toBe("Test Job");
    expect(job.id).toBe("test-job");
    expect(job.prompt).toBe("Do something useful");
    expect(job.schedule).toBe("0 8 * * *");
    expect(job.recurring).toBe(true);
    expect(job.backendType).toBe("claude");
    expect(job.permissionMode).toBe("bypassPermissions");
    expect(job.consecutiveFailures).toBe(0);
    expect(job.totalRuns).toBe(0);
    expect(job.createdAt).toBeGreaterThanOrEqual(before);
    expect(job.createdAt).toBeLessThanOrEqual(after);
    expect(job.updatedAt).toBe(job.createdAt);
  });

  it("persists the job to disk as JSON", () => {
    cronStore.createJob(makeJobInput({ name: "Disk Check" }));

    const raw = readFileSync(join(cronDir(), "disk-check.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe("Disk Check");
    expect(parsed.id).toBe("disk-check");
  });

  it("throws when creating a duplicate slug", () => {
    cronStore.createJob(makeJobInput({ name: "My Task" }));
    expect(() => cronStore.createJob(makeJobInput({ name: "My Task" }))).toThrow(
      'A job with a similar name already exists ("my-task")',
    );
  });

  it("trims the name before saving", () => {
    const job = cronStore.createJob(makeJobInput({ name: "  Spaced Out  " }));
    expect(job.name).toBe("Spaced Out");
    expect(job.id).toBe("spaced-out");
  });

  it("throws when prompt is empty", () => {
    expect(() => cronStore.createJob(makeJobInput({ prompt: "" }))).toThrow("Job prompt is required");
  });

  it("throws when schedule is empty", () => {
    expect(() => cronStore.createJob(makeJobInput({ schedule: "" }))).toThrow("Job schedule is required");
  });

  it("throws when cwd is empty", () => {
    expect(() => cronStore.createJob(makeJobInput({ cwd: "" }))).toThrow("Job working directory is required");
  });
});

// ===========================================================================
// updateJob
// ===========================================================================
describe("updateJob", () => {
  it("updates fields and preserves createdAt", async () => {
    const job = cronStore.createJob(makeJobInput({ name: "Original" }));
    const originalCreatedAt = job.createdAt;

    await new Promise((r) => setTimeout(r, 10));

    const updated = cronStore.updateJob("original", {
      prompt: "Updated prompt",
    });

    expect(updated).not.toBeNull();
    expect(updated!.prompt).toBe("Updated prompt");
    expect(updated!.createdAt).toBe(originalCreatedAt);
    expect(updated!.updatedAt).toBeGreaterThan(originalCreatedAt);
  });

  it("renames the file on disk when name/slug changes", () => {
    cronStore.createJob(makeJobInput({ name: "Old Name" }));

    cronStore.updateJob("old-name", { name: "New Name" });

    // Old file should be gone, new file should exist
    expect(() => readFileSync(join(cronDir(), "old-name.json"), "utf-8")).toThrow();
    const parsed = JSON.parse(readFileSync(join(cronDir(), "new-name.json"), "utf-8"));
    expect(parsed.name).toBe("New Name");
    expect(parsed.id).toBe("new-name");
  });

  it("throws on slug collision during rename", () => {
    cronStore.createJob(makeJobInput({ name: "Alpha" }));
    cronStore.createJob(makeJobInput({ name: "Beta" }));

    expect(() => cronStore.updateJob("alpha", { name: "Beta" })).toThrow(
      'A job with a similar name already exists ("beta")',
    );
  });

  it("returns null for a non-existent id", () => {
    expect(cronStore.updateJob("ghost", { name: "New" })).toBeNull();
  });

  it("updates tracking fields like consecutiveFailures", () => {
    cronStore.createJob(makeJobInput({ name: "Tracked" }));

    const updated = cronStore.updateJob("tracked", {
      consecutiveFailures: 3,
      totalRuns: 10,
      lastRunAt: Date.now(),
      lastSessionId: "session-123",
    });

    expect(updated!.consecutiveFailures).toBe(3);
    expect(updated!.totalRuns).toBe(10);
    expect(updated!.lastSessionId).toBe("session-123");
  });
});

// ===========================================================================
// deleteJob
// ===========================================================================
describe("deleteJob", () => {
  it("deletes an existing job and returns true", () => {
    cronStore.createJob(makeJobInput({ name: "To Delete" }));
    expect(cronStore.deleteJob("to-delete")).toBe(true);
    expect(cronStore.getJob("to-delete")).toBeNull();
  });

  it("returns false when the job does not exist", () => {
    expect(cronStore.deleteJob("missing")).toBe(false);
  });

  it("removes the file from disk", () => {
    cronStore.createJob(makeJobInput({ name: "Disk Gone" }));
    expect(() => readFileSync(join(cronDir(), "disk-gone.json"), "utf-8")).not.toThrow();

    cronStore.deleteJob("disk-gone");
    expect(() => readFileSync(join(cronDir(), "disk-gone.json"), "utf-8")).toThrow();
  });

  it("does not affect other jobs when deleting one", () => {
    cronStore.createJob(makeJobInput({ name: "Keep Me" }));
    cronStore.createJob(makeJobInput({ name: "Delete Me" }));

    cronStore.deleteJob("delete-me");

    expect(cronStore.getJob("keep-me")).not.toBeNull();
    expect(cronStore.listJobs()).toHaveLength(1);
  });
});

// ===========================================================================
// Edge cases & integration
// ===========================================================================
describe("edge cases", () => {
  it("handles unicode in job names by stripping non-alphanumeric", () => {
    // Unicode characters get stripped, leaving only alphanumeric + hyphens
    const job = cronStore.createJob(makeJobInput({ name: "café résumé" }));
    expect(job.id).toBe("caf-rsum");
  });

  it("handles very long names by preserving full slug", () => {
    const longName = "a".repeat(200);
    const job = cronStore.createJob(makeJobInput({ name: longName }));
    expect(job.id).toBe(longName.toLowerCase());
  });

  it("preserves all CronJob fields through create → get round-trip", () => {
    // Every field in the CronJob interface should survive serialization
    const input = makeJobInput({
      name: "Full Round Trip",
      prompt: "Complex prompt\nwith newlines\nand special chars: @#$%",
      schedule: "*/5 * * * *",
      recurring: true,
      backendType: "codex",
      model: "gpt-5.3-codex",
      cwd: "/home/user/project",
      envSlug: "production",
      enabled: false,
      permissionMode: "plan",
      codexInternetAccess: true,
    });

    const created = cronStore.createJob(input);
    const retrieved = cronStore.getJob(created.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Full Round Trip");
    expect(retrieved!.prompt).toBe(input.prompt);
    expect(retrieved!.schedule).toBe("*/5 * * * *");
    expect(retrieved!.recurring).toBe(true);
    expect(retrieved!.backendType).toBe("codex");
    expect(retrieved!.model).toBe("gpt-5.3-codex");
    expect(retrieved!.cwd).toBe("/home/user/project");
    expect(retrieved!.envSlug).toBe("production");
    expect(retrieved!.enabled).toBe(false);
    expect(retrieved!.permissionMode).toBe("plan");
    expect(retrieved!.codexInternetAccess).toBe(true);
    expect(retrieved!.consecutiveFailures).toBe(0);
    expect(retrieved!.totalRuns).toBe(0);
  });

  it("preserves all fields through create → update → get round-trip", () => {
    cronStore.createJob(makeJobInput({ name: "Update Trip" }));

    cronStore.updateJob("update-trip", {
      prompt: "New prompt",
      schedule: "0 12 * * *",
      recurring: false,
      backendType: "codex",
      model: "gpt-5.2",
      cwd: "/new/path",
      envSlug: "staging",
      enabled: false,
      permissionMode: "plan",
      codexInternetAccess: true,
      consecutiveFailures: 2,
      totalRuns: 15,
      lastRunAt: 1700000000000,
      lastSessionId: "sess-abc",
    });

    const result = cronStore.getJob("update-trip");
    expect(result!.prompt).toBe("New prompt");
    expect(result!.schedule).toBe("0 12 * * *");
    expect(result!.recurring).toBe(false);
    expect(result!.backendType).toBe("codex");
    expect(result!.model).toBe("gpt-5.2");
    expect(result!.cwd).toBe("/new/path");
    expect(result!.envSlug).toBe("staging");
    expect(result!.enabled).toBe(false);
    expect(result!.permissionMode).toBe("plan");
    expect(result!.codexInternetAccess).toBe(true);
    expect(result!.consecutiveFailures).toBe(2);
    expect(result!.totalRuns).toBe(15);
    expect(result!.lastRunAt).toBe(1700000000000);
    expect(result!.lastSessionId).toBe("sess-abc");
  });

  it("can create multiple jobs and list them all", () => {
    for (let i = 0; i < 10; i++) {
      cronStore.createJob(makeJobInput({ name: `Job ${i}` }));
    }
    expect(cronStore.listJobs()).toHaveLength(10);
  });

  it("handles delete then re-create of same name", () => {
    cronStore.createJob(makeJobInput({ name: "Recycled" }));
    cronStore.deleteJob("recycled");
    // Should not throw — slot is now free
    const job = cronStore.createJob(makeJobInput({ name: "Recycled" }));
    expect(job.id).toBe("recycled");
  });

  it("updateJob does not allow overriding createdAt", () => {
    const job = cronStore.createJob(makeJobInput({ name: "Immutable Dates" }));
    const originalCreatedAt = job.createdAt;

    cronStore.updateJob("immutable-dates", { createdAt: 0 } as Partial<import("./cron-types.js").CronJob>);

    const updated = cronStore.getJob("immutable-dates");
    expect(updated!.createdAt).toBe(originalCreatedAt);
  });

  it("trims prompt and schedule whitespace on create", () => {
    const job = cronStore.createJob(makeJobInput({
      name: "Trim Test",
      prompt: "  spaced prompt  ",
      schedule: "  0 8 * * *  ",
      cwd: "  /tmp/test  ",
    }));
    expect(job.prompt).toBe("spaced prompt");
    expect(job.schedule).toBe("0 8 * * *");
    expect(job.cwd).toBe("/tmp/test");
  });

  it("skips non-JSON files in the cron directory", () => {
    cronStore.createJob(makeJobInput({ name: "Valid" }));
    writeFileSync(join(cronDir(), "readme.txt"), "not a job", "utf-8");
    writeFileSync(join(cronDir(), "notes.md"), "# notes", "utf-8");

    const jobs = cronStore.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("Valid");
  });
});
