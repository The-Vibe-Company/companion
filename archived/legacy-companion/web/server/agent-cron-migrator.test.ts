import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CronJob } from "./cron-types.js";
import type { AgentConfig } from "./agent-types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

/**
 * Mock for node:fs. We use vi.hoisted so the mock functions are created before
 * vi.mock() is hoisted, allowing us to control return values per-test.
 */
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  readdirSync: vi.fn<(path: string) => string[]>(),
  readFileSync: vi.fn<(path: string, encoding: string) => string>(),
  writeFileSync: vi.fn<(path: string, data: string, encoding: string) => void>(),
}));

vi.mock("node:fs", () => ({
  existsSync: fsMock.existsSync,
  readdirSync: fsMock.readdirSync,
  readFileSync: fsMock.readFileSync,
  writeFileSync: fsMock.writeFileSync,
}));

/**
 * Mock for agent-store.js. We stub listAgents and createAgent to avoid
 * real filesystem operations and to verify the migrator calls them correctly.
 */
const agentStoreMock = vi.hoisted(() => ({
  listAgents: vi.fn<() => AgentConfig[]>(),
  createAgent: vi.fn<(data: unknown) => AgentConfig>(),
}));

vi.mock("./agent-store.js", () => ({
  listAgents: agentStoreMock.listAgents,
  createAgent: agentStoreMock.createAgent,
}));

/**
 * Mock for paths.js. We point COMPANION_HOME at a fake temp directory
 * so that CRON_DIR and MIGRATION_FLAG paths are deterministic in tests.
 */
vi.mock("./paths.js", () => ({
  COMPANION_HOME: "/tmp/test-companion-home",
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const COMPANION_HOME = "/tmp/test-companion-home";
const CRON_DIR = `${COMPANION_HOME}/cron`;
const MIGRATION_FLAG = `${COMPANION_HOME}/.cron-migrated`;

/**
 * Build a valid CronJob object with sensible defaults.
 * Override any fields via the `overrides` parameter.
 */
function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "daily-check",
    name: "Daily Check",
    prompt: "Run the daily checks",
    schedule: "0 8 * * *",
    recurring: true,
    backendType: "claude",
    model: "claude-sonnet-4-6",
    cwd: "/home/user/project",
    enabled: true,
    permissionMode: "bypassPermissions",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    consecutiveFailures: 0,
    totalRuns: 5,
    ...overrides,
  };
}

/**
 * Build a minimal AgentConfig used as a return value from listAgents.
 */
function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "daily-check",
    version: 1,
    name: "Daily Check",
    description: "",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    cwd: "/home/user/project",
    prompt: "Run the daily checks",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

let migrateCronJobsToAgents: typeof import("./agent-cron-migrator.js").migrateCronJobsToAgents;

beforeEach(async () => {
  vi.clearAllMocks();

  // Reset module cache so each test gets a fresh import
  vi.resetModules();
  const mod = await import("./agent-cron-migrator.js");
  migrateCronJobsToAgents = mod.migrateCronJobsToAgents;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Early return: migration flag already exists
// ===========================================================================
describe("when migration flag already exists", () => {
  it("returns early with {migrated: 0, skipped: 0} without reading cron directory", () => {
    // If the .cron-migrated flag file exists, the function should bail out
    // immediately without touching the filesystem further or calling agent-store.
    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return true;
      return false;
    });

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 0 });
    // Should NOT read the cron directory or call agent-store at all
    expect(fsMock.readdirSync).not.toHaveBeenCalled();
    expect(agentStoreMock.listAgents).not.toHaveBeenCalled();
    expect(agentStoreMock.createAgent).not.toHaveBeenCalled();
    // Should NOT write the migration flag (it already exists)
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// No cron directory exists
// ===========================================================================
describe("when cron directory does not exist", () => {
  it("creates the migration flag and returns {migrated: 0, skipped: 0}", () => {
    // When there is no .cron-migrated flag AND no cron/ directory,
    // the function should write the flag (nothing to migrate) and return zeros.
    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return false;
      return false;
    });

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 0 });
    // Should write the migration flag to prevent future runs
    expect(fsMock.writeFileSync).toHaveBeenCalledOnce();
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      MIGRATION_FLAG,
      expect.any(String),
      "utf-8",
    );
    // Should NOT attempt to read cron files or touch agent-store
    expect(fsMock.readdirSync).not.toHaveBeenCalled();
    expect(agentStoreMock.listAgents).not.toHaveBeenCalled();
    expect(agentStoreMock.createAgent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Successful migration of cron jobs
// ===========================================================================
describe("migrating cron job files to agents", () => {
  it("creates an agent for each valid cron job file and returns correct counts", () => {
    // Two valid cron job JSON files in the cron/ directory should produce
    // two createAgent calls and the returned migrated count should be 2.
    const job1 = makeCronJob({ id: "job-one", name: "Job One" });
    const job2 = makeCronJob({
      id: "job-two",
      name: "Job Two",
      schedule: "*/30 * * * *",
      recurring: true,
      backendType: "codex",
      model: "gpt-5.3-codex",
      envSlug: "production",
      codexInternetAccess: true,
    });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["job-one.json", "job-two.json"]);
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (path === `${CRON_DIR}/job-one.json`) return JSON.stringify(job1);
      if (path === `${CRON_DIR}/job-two.json`) return JSON.stringify(job2);
      throw new Error(`Unexpected readFileSync call: ${path}`);
    });

    // No existing agents, so nothing is skipped
    agentStoreMock.listAgents.mockReturnValue([]);
    agentStoreMock.createAgent.mockReturnValue(makeAgentConfig());

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 2, skipped: 0 });
    expect(agentStoreMock.createAgent).toHaveBeenCalledTimes(2);

    // Verify the first call includes the correct agent configuration
    const firstCallArg = agentStoreMock.createAgent.mock.calls[0][0];
    expect(firstCallArg).toMatchObject({
      version: 1,
      name: "Job One",
      description: "Migrated from scheduled job: Job One",
      icon: "\u23F0",
      backendType: "claude",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      prompt: "Run the daily checks",
      enabled: true,
      triggers: {
        schedule: {
          enabled: true,
          expression: "0 8 * * *",
          recurring: true,
        },
      },
    });

    // Verify the second call maps codex-specific fields correctly
    const secondCallArg = agentStoreMock.createAgent.mock.calls[1][0];
    expect(secondCallArg).toMatchObject({
      name: "Job Two",
      backendType: "codex",
      model: "gpt-5.3-codex",
      envSlug: "production",
      codexInternetAccess: true,
      triggers: {
        schedule: {
          enabled: true,
          expression: "*/30 * * * *",
          recurring: true,
        },
      },
    });

    // Should write the migration flag after completion
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      MIGRATION_FLAG,
      expect.any(String),
      "utf-8",
    );
  });

  it("only processes .json files, ignoring other file types in cron directory", () => {
    // Non-JSON files (e.g. .bak, .md) in the cron directory should be skipped
    // by the .endsWith(".json") filter before any parsing occurs.
    const job = makeCronJob({ id: "only-json", name: "Only JSON" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue([
      "valid-job.json",
      "backup.bak",
      "notes.md",
      ".hidden",
    ]);
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (path === `${CRON_DIR}/valid-job.json`) return JSON.stringify(job);
      throw new Error(`Unexpected readFileSync call: ${path}`);
    });
    agentStoreMock.listAgents.mockReturnValue([]);
    agentStoreMock.createAgent.mockReturnValue(makeAgentConfig());

    const result = migrateCronJobsToAgents();

    // Only the one .json file should be processed
    expect(result).toEqual({ migrated: 1, skipped: 0 });
    expect(fsMock.readFileSync).toHaveBeenCalledOnce();
    expect(agentStoreMock.createAgent).toHaveBeenCalledOnce();
  });

  it("passes cwd from the cron job to the created agent", () => {
    // The agent's cwd should match the cron job's cwd exactly.
    const job = makeCronJob({ name: "CWD Test", cwd: "/custom/working/dir" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["cwd-test.json"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(job));
    agentStoreMock.listAgents.mockReturnValue([]);
    agentStoreMock.createAgent.mockReturnValue(makeAgentConfig());

    migrateCronJobsToAgents();

    expect(agentStoreMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/custom/working/dir" }),
    );
  });

  it("maps disabled cron job to disabled agent with disabled schedule trigger", () => {
    // A cron job with enabled=false should produce an agent with enabled=false
    // and triggers.schedule.enabled=false.
    const disabledJob = makeCronJob({ name: "Disabled Job", enabled: false });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["disabled.json"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(disabledJob));
    agentStoreMock.listAgents.mockReturnValue([]);
    agentStoreMock.createAgent.mockReturnValue(makeAgentConfig());

    migrateCronJobsToAgents();

    expect(agentStoreMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        triggers: {
          schedule: {
            enabled: false,
            expression: "0 8 * * *",
            recurring: true,
          },
        },
      }),
    );
  });
});

// ===========================================================================
// Skipping: agent with same name already exists
// ===========================================================================
describe("when an agent with the same name already exists", () => {
  it("skips the cron job and increments the skipped count", () => {
    // If listAgents returns an agent whose name matches (case-insensitive)
    // the cron job name, that job should be skipped without calling createAgent.
    const job = makeCronJob({ name: "Existing Agent" });
    const existingAgent = makeAgentConfig({ name: "Existing Agent" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["existing.json"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(job));
    agentStoreMock.listAgents.mockReturnValue([existingAgent]);

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 1 });
    expect(agentStoreMock.createAgent).not.toHaveBeenCalled();
  });

  it("performs case-insensitive name comparison when checking for duplicates", () => {
    // The duplicate check uses .toLowerCase() on both sides, so
    // "DAILY CHECK" should match an existing agent named "daily check".
    const job = makeCronJob({ name: "DAILY CHECK" });
    const existingAgent = makeAgentConfig({ name: "daily check" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["daily-check.json"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(job));
    agentStoreMock.listAgents.mockReturnValue([existingAgent]);

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 1 });
    expect(agentStoreMock.createAgent).not.toHaveBeenCalled();
  });

  it("migrates jobs without duplicates while skipping the ones that exist", () => {
    // Mixed scenario: two cron jobs, one with a matching agent name and one without.
    // Only the non-duplicate should be migrated.
    const jobNew = makeCronJob({ name: "New Job" });
    const jobExisting = makeCronJob({ name: "Already There" });
    const existingAgent = makeAgentConfig({ name: "Already There" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["new-job.json", "already-there.json"]);
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (path === `${CRON_DIR}/new-job.json`) return JSON.stringify(jobNew);
      if (path === `${CRON_DIR}/already-there.json`) return JSON.stringify(jobExisting);
      throw new Error(`Unexpected readFileSync call: ${path}`);
    });
    agentStoreMock.listAgents.mockReturnValue([existingAgent]);
    agentStoreMock.createAgent.mockReturnValue(makeAgentConfig({ name: "New Job" }));

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 1, skipped: 1 });
    expect(agentStoreMock.createAgent).toHaveBeenCalledOnce();
    expect(agentStoreMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New Job" }),
    );
  });
});

// ===========================================================================
// Handling corrupt JSON files
// ===========================================================================
describe("when cron job files contain corrupt JSON", () => {
  it("skips corrupt files gracefully and increments the skipped count", () => {
    // Invalid JSON should be caught by the try/catch, logged, and counted
    // as skipped rather than crashing the entire migration.
    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["corrupt.json"]);
    fsMock.readFileSync.mockReturnValue("NOT VALID JSON{{{");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 1 });
    expect(agentStoreMock.createAgent).not.toHaveBeenCalled();
    // Should log the error for debugging
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cron-migrator] Failed to migrate corrupt.json:"),
      expect.anything(),
    );

    consoleSpy.mockRestore();
  });

  it("continues migrating valid files after encountering a corrupt file", () => {
    // A corrupt file should not prevent subsequent valid files from being processed.
    const validJob = makeCronJob({ name: "Valid Job" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["corrupt.json", "valid.json"]);
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (path === `${CRON_DIR}/corrupt.json`) return "{broken json!!";
      if (path === `${CRON_DIR}/valid.json`) return JSON.stringify(validJob);
      throw new Error(`Unexpected readFileSync call: ${path}`);
    });
    agentStoreMock.listAgents.mockReturnValue([]);
    agentStoreMock.createAgent.mockReturnValue(makeAgentConfig({ name: "Valid Job" }));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 1, skipped: 1 });
    expect(agentStoreMock.createAgent).toHaveBeenCalledOnce();
    expect(agentStoreMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Valid Job" }),
    );

    consoleSpy.mockRestore();
  });

  it("handles createAgent throwing an error by counting it as skipped", () => {
    // If agent-store.createAgent throws (e.g. slug collision, missing field),
    // the migrator should catch it and count the job as skipped.
    const job = makeCronJob({ name: "Failing Agent" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["failing.json"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(job));
    agentStoreMock.listAgents.mockReturnValue([]);
    agentStoreMock.createAgent.mockImplementation(() => {
      throw new Error("Agent creation failed for testing");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 1 });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cron-migrator] Failed to migrate failing.json:"),
      expect.anything(),
    );

    consoleSpy.mockRestore();
  });
});

// ===========================================================================
// Migration flag written after processing
// ===========================================================================
describe("migration flag file", () => {
  it("writes the migration flag after successfully processing all files", () => {
    // After processing (even if some files are skipped), the migration flag
    // should be written to prevent re-running on next startup.
    const job = makeCronJob({ name: "Flagged Job" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["flagged.json"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(job));
    agentStoreMock.listAgents.mockReturnValue([]);
    agentStoreMock.createAgent.mockReturnValue(makeAgentConfig());

    migrateCronJobsToAgents();

    // The last writeFileSync call should be the migration flag
    const writeFileCalls = fsMock.writeFileSync.mock.calls;
    const flagCall = writeFileCalls.find(
      (call) => call[0] === MIGRATION_FLAG,
    );
    expect(flagCall).toBeDefined();
    // The flag content should be an ISO date string
    expect(flagCall![1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes the flag even when all jobs are skipped", () => {
    // The migration flag should be written regardless of whether any jobs
    // were actually migrated — skipping all jobs still counts as "done".
    const job = makeCronJob({ name: "Skip Me" });
    const existing = makeAgentConfig({ name: "Skip Me" });

    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["skip-me.json"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify(job));
    agentStoreMock.listAgents.mockReturnValue([existing]);

    migrateCronJobsToAgents();

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      MIGRATION_FLAG,
      expect.any(String),
      "utf-8",
    );
  });
});

// ===========================================================================
// Empty cron directory
// ===========================================================================
describe("when cron directory exists but is empty", () => {
  it("writes the migration flag and returns {migrated: 0, skipped: 0}", () => {
    // An empty cron/ directory (no .json files) should produce zero counts
    // but still mark migration as complete.
    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue([]);

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 0 });
    expect(agentStoreMock.createAgent).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      MIGRATION_FLAG,
      expect.any(String),
      "utf-8",
    );
  });

  it("writes the migration flag when directory has only non-JSON files", () => {
    // Files that don't end with .json are filtered out, producing an empty
    // list effectively identical to an empty directory.
    fsMock.existsSync.mockImplementation((path: string) => {
      if (path === MIGRATION_FLAG) return false;
      if (path === CRON_DIR) return true;
      return false;
    });
    fsMock.readdirSync.mockReturnValue(["readme.txt", ".gitkeep", "backup.bak"]);

    const result = migrateCronJobsToAgents();

    expect(result).toEqual({ migrated: 0, skipped: 0 });
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      MIGRATION_FLAG,
      expect.any(String),
      "utf-8",
    );
  });
});
