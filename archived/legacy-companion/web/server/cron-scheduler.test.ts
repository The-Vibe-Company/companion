import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CronJob } from "./cron-types.js";

// Mock homedir so cron-store writes to a temp directory
const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => { dir = d; },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.get() };
});

// Mock session-names to avoid side effects
vi.mock("./session-names.js", () => ({
  setName: vi.fn(),
  getName: vi.fn(),
}));

let tempDir: string;
let cronStore: typeof import("./cron-store.js");
let CronSchedulerClass: typeof import("./cron-scheduler.js").CronScheduler;

// Minimal mock launcher
function createMockLauncher() {
  const sessions = new Map<string, { sessionId: string; state: string; exitCode?: number | null; cronJobId?: string; cronJobName?: string }>();
  let launchCount = 0;
  return {
    launch: vi.fn((options: Record<string, unknown>) => {
      const sessionId = `mock-session-${++launchCount}`;
      const info = {
        sessionId,
        state: "connected", // immediately connected for testing
        model: options.model as string,
        permissionMode: options.permissionMode as string,
        cwd: (options.cwd as string) || "/tmp",
        createdAt: Date.now(),
        backendType: options.backendType as string,
      };
      sessions.set(sessionId, info);
      return info;
    }),
    getSession: vi.fn((id: string) => sessions.get(id)),
    isAlive: vi.fn((id: string) => {
      const s = sessions.get(id);
      return !!s && s.state !== "exited";
    }),
    sessions,
  };
}

// Minimal mock wsBridge
function createMockBridge() {
  return {
    injectUserMessage: vi.fn(),
  };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    prompt: "Do something",
    schedule: "0 8 * * *",
    recurring: true,
    backendType: "claude",
    model: "claude-sonnet-4-6",
    cwd: "/tmp/test",
    enabled: true,
    permissionMode: "bypassPermissions",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    consecutiveFailures: 0,
    totalRuns: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cron-sched-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  cronStore = await import("./cron-store.js");
  const mod = await import("./cron-scheduler.js");
  CronSchedulerClass = mod.CronScheduler;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ===========================================================================
// Scheduling
// ===========================================================================
describe("scheduling", () => {
  it("schedules a recurring job and tracks the timer", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const job = makeJob();
    scheduler.scheduleJob(job);

    // Should have a next run time
    const nextRun = scheduler.getNextRunTime("test-job");
    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun!.getTime()).toBeGreaterThan(Date.now());

    scheduler.destroy();
  });

  it("stops a job timer", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const job = makeJob();
    scheduler.scheduleJob(job);
    expect(scheduler.getNextRunTime("test-job")).not.toBeNull();

    scheduler.stopJob("test-job");
    expect(scheduler.getNextRunTime("test-job")).toBeNull();

    scheduler.destroy();
  });

  it("skips disabled jobs", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const job = makeJob({ enabled: false });
    scheduler.scheduleJob(job);

    expect(scheduler.getNextRunTime("test-job")).toBeNull();
    scheduler.destroy();
  });

  it("skips one-shot jobs in the past", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const job = makeJob({ recurring: false, schedule: pastDate });
    scheduler.scheduleJob(job);

    expect(scheduler.getNextRunTime("test-job")).toBeNull();
    scheduler.destroy();
  });

  it("startAll loads and schedules enabled jobs from store", () => {
    // Create jobs in store
    cronStore.createJob({
      name: "Enabled Job",
      prompt: "Do it",
      schedule: "0 9 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });
    cronStore.createJob({
      name: "Disabled Job",
      prompt: "Skip me",
      schedule: "0 10 * * *",
      recurring: true,
      backendType: "codex",
      model: "o3",
      cwd: "/tmp",
      enabled: false,
      permissionMode: "bypassPermissions",
    });

    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);
    scheduler.startAll();

    expect(scheduler.getNextRunTime("enabled-job")).not.toBeNull();
    expect(scheduler.getNextRunTime("disabled-job")).toBeNull();

    scheduler.destroy();
  });
});

// ===========================================================================
// Execution
// ===========================================================================
describe("execution", () => {
  it("launches a session and injects the prompt", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Create job in store so executeJob can read it
    cronStore.createJob({
      name: "Run Me",
      prompt: "Check PRs",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp/repo",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("run-me");

    // Verify launcher was called with correct params
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        cwd: "/tmp/repo",
        backendType: "claude",
      }),
    );

    // Verify prompt was injected with cron prefix
    expect(bridge.injectUserMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^mock-session-/),
      expect.stringContaining("[cron:run-me Run Me]"),
    );
    expect(bridge.injectUserMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Check PRs"),
    );

    // Verify job tracking was updated
    const updated = cronStore.getJob("run-me");
    expect(updated!.totalRuns).toBe(1);
    expect(updated!.consecutiveFailures).toBe(0);
    expect(updated!.lastRunAt).toBeGreaterThan(0);
    expect(updated!.lastSessionId).toMatch(/^mock-session-/);

    // Verify execution history
    const execs = scheduler.getExecutions("run-me");
    expect(execs).toHaveLength(1);
    expect(execs[0].success).toBe(true);

    scheduler.destroy();
  });

  it("skips execution when previous run is still alive", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Create job and set lastSessionId to a still-alive session
    cronStore.createJob({
      name: "Overlap Test",
      prompt: "Do it",
      schedule: "* * * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    // Run once to get a lastSessionId
    await scheduler.executeJob("overlap-test");
    const firstSessionId = cronStore.getJob("overlap-test")!.lastSessionId!;
    expect(launcher.isAlive(firstSessionId)).toBe(true);

    // Try to run again — should skip
    launcher.launch.mockClear();
    await scheduler.executeJob("overlap-test");
    expect(launcher.launch).not.toHaveBeenCalled();

    scheduler.destroy();
  });

  it("tracks failures and auto-disables after 5 consecutive failures", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Make launcher return a session that immediately exits
    launcher.launch.mockImplementation((options: Record<string, unknown>) => {
      const info = {
        sessionId: `fail-${Date.now()}`,
        state: "exited",
        exitCode: 1,
        model: (options.model as string) || "",
        permissionMode: (options.permissionMode as string) || "",
        cwd: (options.cwd as string) || "/tmp",
        createdAt: Date.now(),
        backendType: (options.backendType as string) || "claude",
      };
      launcher.sessions.set(info.sessionId, info);
      return info;
    });

    cronStore.createJob({
      name: "Failing Job",
      prompt: "Will fail",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    // Execute 5 times (each should fail because the CLI exits immediately)
    for (let i = 0; i < 5; i++) {
      await scheduler.executeJob("failing-job");
    }

    const job = cronStore.getJob("failing-job");
    expect(job!.enabled).toBe(false);
    expect(job!.consecutiveFailures).toBe(5);

    scheduler.destroy();
  });

  it("skips disabled jobs during execution", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Disabled",
      prompt: "Skip",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: false,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("disabled");
    expect(launcher.launch).not.toHaveBeenCalled();

    scheduler.destroy();
  });

  it("passes codexSandbox=danger-full-access for Codex jobs with bypassPermissions", async () => {
    // Codex cron jobs must launch with explicit full autonomy params:
    // codexSandbox="danger-full-access" and codexInternetAccess=true
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Codex Auto",
      prompt: "Check PRs",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "codex",
      model: "gpt-5.3-codex",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("codex-auto");

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        permissionMode: "bypassPermissions",
        codexSandbox: "danger-full-access",
        codexInternetAccess: true,
      }),
    );

    scheduler.destroy();
  });

  it("defaults codexInternetAccess to true for Codex cron jobs when not explicitly set", async () => {
    // When codexInternetAccess is not set on the job, it should default to true
    // for Codex autonomous sessions (no point running autonomous without internet)
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Codex Default Internet",
      prompt: "Fetch latest",
      schedule: "0 9 * * *",
      recurring: true,
      backendType: "codex",
      model: "gpt-5.3-codex",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
      // codexInternetAccess NOT set
    });

    await scheduler.executeJob("codex-default-internet");

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        codexInternetAccess: true,
      }),
    );

    scheduler.destroy();
  });

  it("does not pass codexSandbox for Claude jobs", async () => {
    // Claude Code doesn't use codexSandbox — it uses --permission-mode directly
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Claude Job",
      prompt: "Run tests",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("claude-job");

    const launchArgs = launcher.launch.mock.calls[0][0];
    expect(launchArgs.codexSandbox).toBeUndefined();
    expect(launchArgs.codexInternetAccess).toBeUndefined();

    scheduler.destroy();
  });
});

// ===========================================================================
// Execution history
// ===========================================================================
describe("execution history", () => {
  it("tracks multiple executions per job", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Multi Run",
      prompt: "Go",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    // Run 3 times — need to mark previous sessions as exited to avoid overlap skip
    await scheduler.executeJob("multi-run");
    const sess1 = cronStore.getJob("multi-run")!.lastSessionId!;
    launcher.sessions.get(sess1)!.state = "exited";

    await scheduler.executeJob("multi-run");
    const sess2 = cronStore.getJob("multi-run")!.lastSessionId!;
    launcher.sessions.get(sess2)!.state = "exited";

    await scheduler.executeJob("multi-run");

    const execs = scheduler.getExecutions("multi-run");
    expect(execs).toHaveLength(3);
    // All should be successful
    expect(execs.every((e) => e.success === true)).toBe(true);
    // Each should have a unique session ID
    const sessionIds = new Set(execs.map((e) => e.sessionId));
    expect(sessionIds.size).toBe(3);

    scheduler.destroy();
  });

  it("returns empty array for unknown job", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    expect(scheduler.getExecutions("nonexistent")).toEqual([]);

    scheduler.destroy();
  });

  it("records error details on failed executions", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Make launcher return sessions that immediately exit
    launcher.launch.mockImplementation((options: Record<string, unknown>) => {
      const info = {
        sessionId: `fail-${Date.now()}-${Math.random()}`,
        state: "exited",
        exitCode: 1,
        model: (options.model as string) || "",
        permissionMode: (options.permissionMode as string) || "",
        cwd: (options.cwd as string) || "/tmp",
        createdAt: Date.now(),
        backendType: (options.backendType as string) || "claude",
      };
      launcher.sessions.set(info.sessionId, info);
      return info;
    });

    cronStore.createJob({
      name: "Error Detail",
      prompt: "Will fail",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("error-detail");

    const execs = scheduler.getExecutions("error-detail");
    expect(execs).toHaveLength(1);
    expect(execs[0].error).toContain("CLI process exited before connecting");
    expect(execs[0].completedAt).toBeGreaterThan(0);

    scheduler.destroy();
  });
});

// ===========================================================================
// Prompt formatting
// ===========================================================================
describe("prompt formatting", () => {
  it("prefixes prompt with [cron:<id> <name>] tag", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Email Digest",
      prompt: "Read my emails and summarize them",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("email-digest");

    const injectedPrompt = bridge.injectUserMessage.mock.calls[0][1];
    expect(injectedPrompt).toBe("[cron:email-digest Email Digest]\n\nRead my emails and summarize them");

    scheduler.destroy();
  });

  it("sets session name with clock emoji prefix", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const { setName } = await import("./session-names.js");

    cronStore.createJob({
      name: "PR Check",
      prompt: "Check PRs",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("pr-check");

    expect(setName).toHaveBeenCalledWith(
      expect.stringMatching(/^mock-session-/),
      "⏰ PR Check",
    );

    scheduler.destroy();
  });
});

// ===========================================================================
// Session tagging
// ===========================================================================
describe("session tagging", () => {
  it("tags the session with cronJobId and cronJobName", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Tagged Session",
      prompt: "Do work",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("tagged-session");

    // The session should be tagged after launch
    const sessionId = cronStore.getJob("tagged-session")!.lastSessionId!;
    const session = launcher.sessions.get(sessionId);
    expect(session!.cronJobId).toBe("tagged-session");
    expect(session!.cronJobName).toBe("Tagged Session");

    scheduler.destroy();
  });
});

// ===========================================================================
// Failure recovery
// ===========================================================================
describe("failure recovery", () => {
  it("resets consecutiveFailures to 0 on successful execution", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Create a job that has had previous failures
    cronStore.createJob({
      name: "Recovering",
      prompt: "Try again",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });
    // Manually set some failures
    cronStore.updateJob("recovering", { consecutiveFailures: 3 });

    // Execute successfully
    await scheduler.executeJob("recovering");

    const job = cronStore.getJob("recovering");
    expect(job!.consecutiveFailures).toBe(0);
    expect(job!.totalRuns).toBe(1);

    scheduler.destroy();
  });

  it("increments totalRuns on each successful execution", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Counter",
      prompt: "Go",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    // Run 3 times, marking previous sessions as exited
    for (let i = 0; i < 3; i++) {
      await scheduler.executeJob("counter");
      const sid = cronStore.getJob("counter")!.lastSessionId!;
      launcher.sessions.get(sid)!.state = "exited";
    }

    const job = cronStore.getJob("counter");
    expect(job!.totalRuns).toBe(3);

    scheduler.destroy();
  });

  it("does not auto-disable after fewer than 5 failures", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Make launcher return sessions that immediately exit
    launcher.launch.mockImplementation((options: Record<string, unknown>) => {
      const info = {
        sessionId: `fail-${Date.now()}-${Math.random()}`,
        state: "exited",
        exitCode: 1,
        model: (options.model as string) || "",
        permissionMode: (options.permissionMode as string) || "",
        cwd: (options.cwd as string) || "/tmp",
        createdAt: Date.now(),
        backendType: (options.backendType as string) || "claude",
      };
      launcher.sessions.set(info.sessionId, info);
      return info;
    });

    cronStore.createJob({
      name: "Resilient",
      prompt: "Try hard",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    // Execute 4 times (below threshold)
    for (let i = 0; i < 4; i++) {
      await scheduler.executeJob("resilient");
    }

    const job = cronStore.getJob("resilient");
    expect(job!.enabled).toBe(true); // Still enabled
    expect(job!.consecutiveFailures).toBe(4);

    scheduler.destroy();
  });
});

// ===========================================================================
// Non-existent / invalid job handling
// ===========================================================================
describe("invalid job handling", () => {
  it("silently skips execution when job does not exist in store", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Should not throw
    await scheduler.executeJob("ghost-job");
    expect(launcher.launch).not.toHaveBeenCalled();

    scheduler.destroy();
  });

  it("getNextRunTime returns null for unknown job id", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    expect(scheduler.getNextRunTime("nonexistent")).toBeNull();

    scheduler.destroy();
  });

  it("stopJob is a no-op for unknown job id", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    // Should not throw
    scheduler.stopJob("unknown");

    scheduler.destroy();
  });
});

// ===========================================================================
// scheduleJob replaces existing timer
// ===========================================================================
describe("reschedule", () => {
  it("replaces existing timer when scheduleJob is called again", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const job = makeJob({ schedule: "0 8 * * *" });
    scheduler.scheduleJob(job);
    const firstNextRun = scheduler.getNextRunTime("test-job");

    // Reschedule with different cron
    scheduler.scheduleJob({ ...job, schedule: "0 20 * * *" });
    const secondNextRun = scheduler.getNextRunTime("test-job");

    expect(firstNextRun).not.toBeNull();
    expect(secondNextRun).not.toBeNull();
    // Different schedules should produce different next run times
    expect(firstNextRun!.getHours()).not.toBe(secondNextRun!.getHours());

    scheduler.destroy();
  });
});

// ===========================================================================
// One-shot scheduling
// ===========================================================================
describe("one-shot scheduling", () => {
  it("schedules a future one-shot and has a next run time", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const futureDate = new Date(Date.now() + 3_600_000).toISOString(); // +1 hour
    const job = makeJob({ recurring: false, schedule: futureDate });
    scheduler.scheduleJob(job);

    const nextRun = scheduler.getNextRunTime("test-job");
    expect(nextRun).toBeInstanceOf(Date);
    // Should be roughly 1 hour from now
    expect(nextRun!.getTime()).toBeGreaterThan(Date.now());
    expect(nextRun!.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1000);

    scheduler.destroy();
  });
});

// ===========================================================================
// Codex sandbox with non-bypass permission mode
// ===========================================================================
describe("Codex sandbox modes", () => {
  it("passes codexSandbox=workspace-write for Codex jobs with plan mode", async () => {
    // Codex jobs NOT using bypassPermissions should get workspace-write sandbox
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Codex Plan",
      prompt: "Suggest changes",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "codex",
      model: "gpt-5.3-codex",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "plan",
    });

    await scheduler.executeJob("codex-plan");

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        codexSandbox: "workspace-write",
        permissionMode: "plan",
      }),
    );

    scheduler.destroy();
  });

  it("respects explicit codexInternetAccess=false", async () => {
    // If user explicitly sets codexInternetAccess to false, it should be respected
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "Codex No Internet",
      prompt: "Work offline",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "codex",
      model: "gpt-5.3-codex",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
      codexInternetAccess: false,
    });

    await scheduler.executeJob("codex-no-internet");

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        codexInternetAccess: false,
      }),
    );

    scheduler.destroy();
  });
});

// ===========================================================================
// Cleanup
// ===========================================================================
describe("destroy", () => {
  it("stops all timers and clears state", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    const job = makeJob();
    scheduler.scheduleJob(job);
    expect(scheduler.getNextRunTime("test-job")).not.toBeNull();

    scheduler.destroy();
    expect(scheduler.getNextRunTime("test-job")).toBeNull();
    expect(scheduler.getExecutions("test-job")).toEqual([]);
  });

  it("clears execution history for all jobs", async () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    cronStore.createJob({
      name: "History Clear",
      prompt: "Go",
      schedule: "0 8 * * *",
      recurring: true,
      backendType: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      enabled: true,
      permissionMode: "bypassPermissions",
    });

    await scheduler.executeJob("history-clear");
    expect(scheduler.getExecutions("history-clear")).toHaveLength(1);

    scheduler.destroy();
    expect(scheduler.getExecutions("history-clear")).toEqual([]);
  });

  it("stops multiple timers", () => {
    const launcher = createMockLauncher();
    const bridge = createMockBridge();
    const scheduler = new CronSchedulerClass(launcher as any, bridge as any);

    scheduler.scheduleJob(makeJob({ id: "job-1", name: "Job 1", schedule: "0 8 * * *" }));
    scheduler.scheduleJob(makeJob({ id: "job-2", name: "Job 2", schedule: "0 12 * * *" }));
    scheduler.scheduleJob(makeJob({ id: "job-3", name: "Job 3", schedule: "0 18 * * *" }));

    expect(scheduler.getNextRunTime("job-1")).not.toBeNull();
    expect(scheduler.getNextRunTime("job-2")).not.toBeNull();
    expect(scheduler.getNextRunTime("job-3")).not.toBeNull();

    scheduler.destroy();

    expect(scheduler.getNextRunTime("job-1")).toBeNull();
    expect(scheduler.getNextRunTime("job-2")).toBeNull();
    expect(scheduler.getNextRunTime("job-3")).toBeNull();
  });
});
