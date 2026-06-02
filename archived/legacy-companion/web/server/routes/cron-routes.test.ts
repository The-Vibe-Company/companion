import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock cron-store module ─────────────────────────────────────────────────
// Mocked before imports so every `import` of cron-store gets the mock.
vi.mock("../cron-store.js", () => ({
  listJobs: vi.fn(() => []),
  getJob: vi.fn(() => null),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(() => false),
}));

import { Hono } from "hono";
import * as cronStore from "../cron-store.js";
import type { CronJob, CronJobExecution } from "../cron-types.js";
import { registerCronRoutes } from "./cron-routes.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal CronJob fixture with sensible defaults. Override fields as needed. */
function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    prompt: "Run a task",
    schedule: "0 * * * *",
    recurring: true,
    backendType: "claude",
    model: "claude-sonnet-4-6",
    cwd: "/tmp/test",
    enabled: true,
    permissionMode: "bypassPermissions",
    createdAt: 1000,
    updatedAt: 2000,
    consecutiveFailures: 0,
    totalRuns: 0,
    ...overrides,
  };
}

/** Build a mock CronScheduler with vi.fn() stubs for every method the routes use. */
function createMockScheduler() {
  return {
    getNextRunTime: vi.fn((_id?: string) => null as Date | null),
    scheduleJob: vi.fn(),
    stopJob: vi.fn(),
    executeJobManually: vi.fn(),
    getExecutions: vi.fn(() => [] as CronJobExecution[]),
  };
}

// ─── Test setup ─────────────────────────────────────────────────────────────

let app: Hono;
let scheduler: ReturnType<typeof createMockScheduler>;

beforeEach(() => {
  vi.clearAllMocks();

  scheduler = createMockScheduler();

  // Create a Hono app and mount cron routes under /api
  app = new Hono();
  const api = new Hono();
  registerCronRoutes(api, scheduler as any);
  app.route("/api", api);
});

// ─── GET /api/cron/jobs ─────────────────────────────────────────────────────

describe("GET /api/cron/jobs", () => {
  it("returns an empty list when no jobs exist", async () => {
    // Validate that an empty store returns []
    vi.mocked(cronStore.listJobs).mockReturnValue([]);

    const res = await app.request("/api/cron/jobs");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("returns the list of jobs enriched with nextRunAt", async () => {
    // When the scheduler has a next run time, the response should include it as epoch ms
    const job = makeJob();
    vi.mocked(cronStore.listJobs).mockReturnValue([job]);
    const nextRun = new Date("2026-03-01T00:00:00Z");
    scheduler.getNextRunTime.mockReturnValue(nextRun);

    const res = await app.request("/api/cron/jobs");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("test-job");
    expect(json[0].nextRunAt).toBe(nextRun.getTime());
  });

  it("returns nextRunAt as null when the scheduler has no next run time", async () => {
    // If the scheduler returns null (e.g. job is disabled or one-shot already ran),
    // the enriched field should be null rather than omitted
    const job = makeJob({ enabled: false });
    vi.mocked(cronStore.listJobs).mockReturnValue([job]);
    scheduler.getNextRunTime.mockReturnValue(null);

    const res = await app.request("/api/cron/jobs");

    const json = await res.json();
    expect(json[0].nextRunAt).toBeNull();
  });

  it("enriches multiple jobs independently", async () => {
    // Each job should get its own nextRunAt based on its id
    const job1 = makeJob({ id: "job-a", name: "Job A" });
    const job2 = makeJob({ id: "job-b", name: "Job B" });
    vi.mocked(cronStore.listJobs).mockReturnValue([job1, job2]);

    const dateA = new Date("2026-04-01T08:00:00Z");
    scheduler.getNextRunTime.mockImplementation((id?: string) => {
      if (id === "job-a") return dateA;
      return null;
    });

    const res = await app.request("/api/cron/jobs");
    const json = await res.json();

    expect(json).toHaveLength(2);
    expect(json[0].nextRunAt).toBe(dateA.getTime());
    expect(json[1].nextRunAt).toBeNull();
  });
});

// ─── GET /api/cron/jobs/:id ─────────────────────────────────────────────────

describe("GET /api/cron/jobs/:id", () => {
  it("returns the job when it exists", async () => {
    const job = makeJob({ id: "existing" });
    vi.mocked(cronStore.getJob).mockReturnValue(job);

    const res = await app.request("/api/cron/jobs/existing");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe("existing");
  });

  it("returns 404 when the job does not exist", async () => {
    vi.mocked(cronStore.getJob).mockReturnValue(null);

    const res = await app.request("/api/cron/jobs/nonexistent");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Job not found");
  });

  it("enriches the job with nextRunAt from the scheduler", async () => {
    // The single-job endpoint should also attach the next run time
    const job = makeJob({ id: "scheduled" });
    vi.mocked(cronStore.getJob).mockReturnValue(job);
    const nextRun = new Date("2026-06-15T12:00:00Z");
    scheduler.getNextRunTime.mockReturnValue(nextRun);

    const res = await app.request("/api/cron/jobs/scheduled");

    const json = await res.json();
    expect(json.nextRunAt).toBe(nextRun.getTime());
    expect(scheduler.getNextRunTime).toHaveBeenCalledWith("scheduled");
  });

  it("returns nextRunAt as null when the scheduler has no timer for the job", async () => {
    const job = makeJob({ id: "no-timer" });
    vi.mocked(cronStore.getJob).mockReturnValue(job);
    scheduler.getNextRunTime.mockReturnValue(null);

    const res = await app.request("/api/cron/jobs/no-timer");

    const json = await res.json();
    expect(json.nextRunAt).toBeNull();
  });
});

// ─── POST /api/cron/jobs ────────────────────────────────────────────────────

describe("POST /api/cron/jobs", () => {
  it("creates a job and returns 201", async () => {
    const created = makeJob({ id: "my-job", name: "My Job" });
    vi.mocked(cronStore.createJob).mockReturnValue(created);

    const res = await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Job",
        prompt: "Hello",
        schedule: "0 * * * *",
        cwd: "/tmp",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("my-job");
    expect(cronStore.createJob).toHaveBeenCalledTimes(1);
  });

  it("passes all user-supplied fields to createJob", async () => {
    // Ensure every field from the request body is forwarded to the store
    const created = makeJob();
    vi.mocked(cronStore.createJob).mockReturnValue(created);

    await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Full Config",
        prompt: "Do everything",
        schedule: "*/5 * * * *",
        recurring: false,
        backendType: "codex",
        model: "o4-mini",
        cwd: "/home/user/project",
        envSlug: "production",
        enabled: false,
        permissionMode: "default",
        codexInternetAccess: true,
      }),
    });

    expect(cronStore.createJob).toHaveBeenCalledWith({
      name: "Full Config",
      prompt: "Do everything",
      schedule: "*/5 * * * *",
      recurring: false,
      backendType: "codex",
      model: "o4-mini",
      cwd: "/home/user/project",
      envSlug: "production",
      enabled: false,
      permissionMode: "default",
      codexInternetAccess: true,
    });
  });

  it("schedules the job when enabled", async () => {
    // When a new job is created with enabled=true, the scheduler should be called
    const created = makeJob({ enabled: true });
    vi.mocked(cronStore.createJob).mockReturnValue(created);

    await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Enabled Job",
        prompt: "Run",
        schedule: "*/5 * * * *",
        cwd: "/tmp",
      }),
    });

    expect(scheduler.scheduleJob).toHaveBeenCalledWith(created);
  });

  it("does not schedule the job when disabled", async () => {
    // When a new job is created with enabled=false, the scheduler should NOT be called
    const created = makeJob({ enabled: false });
    vi.mocked(cronStore.createJob).mockReturnValue(created);

    await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Disabled Job",
        prompt: "Run",
        schedule: "*/5 * * * *",
        cwd: "/tmp",
        enabled: false,
      }),
    });

    expect(scheduler.scheduleJob).not.toHaveBeenCalled();
  });

  it("returns 400 when the store throws a validation error", async () => {
    // e.g. missing required fields
    vi.mocked(cronStore.createJob).mockImplementation(() => {
      throw new Error("Job name is required");
    });

    const res = await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Job name is required");
  });

  it("returns 400 when a duplicate job name is used", async () => {
    vi.mocked(cronStore.createJob).mockImplementation(() => {
      throw new Error('A job with a similar name already exists ("my-job")');
    });

    const res = await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Job",
        prompt: "Do stuff",
        schedule: "0 * * * *",
        cwd: "/tmp",
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("already exists");
  });

  it("handles invalid JSON body gracefully", async () => {
    // The route catches JSON parse errors via .catch(() => ({})),
    // so it should fall through to createJob with empty strings
    vi.mocked(cronStore.createJob).mockImplementation(() => {
      throw new Error("Job name is required");
    });

    const res = await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("uses sensible defaults for optional fields", async () => {
    // When optional fields are omitted, the route should fill in defaults
    const created = makeJob();
    vi.mocked(cronStore.createJob).mockReturnValue(created);

    await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Minimal Job",
        prompt: "Do something",
        schedule: "0 * * * *",
        cwd: "/tmp",
      }),
    });

    const passedInput = vi.mocked(cronStore.createJob).mock.calls[0][0];
    // Check default values for optional fields
    expect(passedInput.recurring).toBe(true);
    expect(passedInput.backendType).toBe("claude");
    expect(passedInput.model).toBe("");
    expect(passedInput.enabled).toBe(true);
    expect(passedInput.permissionMode).toBe("bypassPermissions");
  });

  it("converts non-Error thrown values to string in the 400 response", async () => {
    // Edge case: the store throws a non-Error value (e.g. a string)
    vi.mocked(cronStore.createJob).mockImplementation(() => {
      throw "raw string error";
    });

    const res = await app.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Job" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("raw string error");
  });
});

// ─── PUT /api/cron/jobs/:id ─────────────────────────────────────────────────

describe("PUT /api/cron/jobs/:id", () => {
  it("updates the job and returns the updated version", async () => {
    const updated = makeJob({ id: "test-job", name: "Updated Name" });
    vi.mocked(cronStore.updateJob).mockReturnValue(updated);

    const res = await app.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Name" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("Updated Name");
    expect(cronStore.updateJob).toHaveBeenCalledWith(
      "test-job",
      expect.objectContaining({ name: "Updated Name" }),
    );
  });

  it("returns 404 when job does not exist", async () => {
    vi.mocked(cronStore.updateJob).mockReturnValue(null);

    const res = await app.request("/api/cron/jobs/nonexistent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Job not found");
  });

  it("strips non-editable fields from the update payload", async () => {
    // Fields like 'id', 'createdAt', 'totalRuns', 'consecutiveFailures'
    // should NOT be passed through to updateJob — only the whitelist applies
    const updated = makeJob();
    vi.mocked(cronStore.updateJob).mockReturnValue(updated);

    await app.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Good Field",
        id: "hacked-id",
        createdAt: 9999,
        updatedAt: 8888,
        totalRuns: 999,
        consecutiveFailures: 100,
        lastRunAt: 7777,
        lastSessionId: "sess-hacked",
      }),
    });

    const passedUpdates = vi.mocked(cronStore.updateJob).mock.calls[0][1];
    // Allowed fields should be present
    expect(passedUpdates).toHaveProperty("name", "Good Field");
    // Non-editable fields should be stripped by the whitelist filter
    expect(passedUpdates).not.toHaveProperty("id");
    expect(passedUpdates).not.toHaveProperty("createdAt");
    expect(passedUpdates).not.toHaveProperty("updatedAt");
    expect(passedUpdates).not.toHaveProperty("totalRuns");
    expect(passedUpdates).not.toHaveProperty("consecutiveFailures");
    expect(passedUpdates).not.toHaveProperty("lastRunAt");
    expect(passedUpdates).not.toHaveProperty("lastSessionId");
  });

  it("allows all whitelisted fields through", async () => {
    // The PUT handler allows: name, prompt, schedule, recurring, backendType,
    // model, cwd, envSlug, enabled, permissionMode, codexInternetAccess
    const updated = makeJob();
    vi.mocked(cronStore.updateJob).mockReturnValue(updated);

    const allowedPayload = {
      name: "New Name",
      prompt: "New Prompt",
      schedule: "*/10 * * * *",
      recurring: false,
      backendType: "codex",
      model: "o4-mini",
      cwd: "/new/path",
      envSlug: "staging",
      enabled: false,
      permissionMode: "default",
      codexInternetAccess: true,
    };

    await app.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allowedPayload),
    });

    const passedUpdates = vi.mocked(cronStore.updateJob).mock.calls[0][1];
    for (const [key, value] of Object.entries(allowedPayload)) {
      expect(passedUpdates).toHaveProperty(key, value);
    }
  });

  it("reschedules the job after update", async () => {
    // After a successful update, the route should always call scheduleJob
    const updated = makeJob({ id: "test-job" });
    vi.mocked(cronStore.updateJob).mockReturnValue(updated);

    await app.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: "*/30 * * * *" }),
    });

    expect(scheduler.scheduleJob).toHaveBeenCalledWith(updated);
  });

  it("stops the old timer when the job id changes (name rename)", async () => {
    // If the update results in a new ID (because name changed), the route
    // should stop the old timer before scheduling the new one
    const updated = makeJob({ id: "new-name" });
    vi.mocked(cronStore.updateJob).mockReturnValue(updated);

    await app.request("/api/cron/jobs/old-name", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });

    // Should stop the old id's timer since updated.id !== param id
    expect(scheduler.stopJob).toHaveBeenCalledWith("old-name");
    // And schedule the updated job
    expect(scheduler.scheduleJob).toHaveBeenCalledWith(updated);
  });

  it("does not stop the old timer when the id stays the same", async () => {
    // When the name doesn't change (or changes to produce the same slug),
    // stopJob should NOT be called for the old id
    const updated = makeJob({ id: "same-id" });
    vi.mocked(cronStore.updateJob).mockReturnValue(updated);

    await app.request("/api/cron/jobs/same-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Updated prompt" }),
    });

    // stopJob should not be called because updated.id === request param id
    expect(scheduler.stopJob).not.toHaveBeenCalled();
    expect(scheduler.scheduleJob).toHaveBeenCalledWith(updated);
  });

  it("returns 400 when the store throws a validation error", async () => {
    vi.mocked(cronStore.updateJob).mockImplementation(() => {
      throw new Error("Job name must contain alphanumeric characters");
    });

    const res = await app.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "!!!" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Job name must contain alphanumeric characters");
  });

  it("handles invalid JSON body gracefully", async () => {
    // The route catches JSON parse errors via .catch(() => ({})),
    // then passes an empty allowed-set to updateJob
    vi.mocked(cronStore.updateJob).mockReturnValue(null);

    const res = await app.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    // updateJob returns null for missing job => 404
    expect(res.status).toBe(404);
  });

  it("converts non-Error thrown values to string in the 400 response", async () => {
    vi.mocked(cronStore.updateJob).mockImplementation(() => {
      throw "raw string error";
    });

    const res = await app.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("raw string error");
  });
});

// ─── DELETE /api/cron/jobs/:id ──────────────────────────────────────────────

describe("DELETE /api/cron/jobs/:id", () => {
  it("deletes an existing job and stops its scheduler", async () => {
    vi.mocked(cronStore.deleteJob).mockReturnValue(true);

    const res = await app.request("/api/cron/jobs/test-job", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    // stopJob should be called BEFORE deleteJob to clean up the timer
    expect(scheduler.stopJob).toHaveBeenCalledWith("test-job");
    expect(cronStore.deleteJob).toHaveBeenCalledWith("test-job");
  });

  it("returns 404 when job does not exist", async () => {
    vi.mocked(cronStore.deleteJob).mockReturnValue(false);

    const res = await app.request("/api/cron/jobs/nonexistent", { method: "DELETE" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Job not found");
  });

  it("always calls stopJob even when deleteJob returns false", async () => {
    // The route calls stopJob unconditionally before checking deleteJob result.
    // This is intentional — clean up any stale timer even if the file is gone.
    vi.mocked(cronStore.deleteJob).mockReturnValue(false);

    await app.request("/api/cron/jobs/stale-job", { method: "DELETE" });

    expect(scheduler.stopJob).toHaveBeenCalledWith("stale-job");
  });
});

// ─── POST /api/cron/jobs/:id/toggle ─────────────────────────────────────────

describe("POST /api/cron/jobs/:id/toggle", () => {
  it("toggles an enabled job to disabled and stops the scheduler", async () => {
    const job = makeJob({ id: "my-job", enabled: true });
    const toggled = makeJob({ id: "my-job", enabled: false });
    vi.mocked(cronStore.getJob).mockReturnValue(job);
    vi.mocked(cronStore.updateJob).mockReturnValue(toggled);

    const res = await app.request("/api/cron/jobs/my-job/toggle", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enabled).toBe(false);
    // Should have called updateJob with enabled: false (opposite of current)
    expect(cronStore.updateJob).toHaveBeenCalledWith("my-job", { enabled: false });
    // When toggled off, should stop the scheduler for this job
    expect(scheduler.stopJob).toHaveBeenCalledWith("my-job");
  });

  it("toggles a disabled job to enabled and schedules it", async () => {
    const job = makeJob({ id: "my-job", enabled: false });
    const toggled = makeJob({ id: "my-job", enabled: true });
    vi.mocked(cronStore.getJob).mockReturnValue(job);
    vi.mocked(cronStore.updateJob).mockReturnValue(toggled);

    const res = await app.request("/api/cron/jobs/my-job/toggle", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enabled).toBe(true);
    // Should have called updateJob with enabled: true
    expect(cronStore.updateJob).toHaveBeenCalledWith("my-job", { enabled: true });
    // When toggled on, should schedule the job
    expect(scheduler.scheduleJob).toHaveBeenCalledWith(toggled);
  });

  it("returns 404 when job does not exist", async () => {
    vi.mocked(cronStore.getJob).mockReturnValue(null);

    const res = await app.request("/api/cron/jobs/nonexistent/toggle", { method: "POST" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Job not found");
  });

  it("does not call scheduleJob when the toggle-on update returns a still-disabled job", async () => {
    // Edge case: updateJob could theoretically return a job that's still disabled
    // (e.g. if store logic overrides). The route checks updated?.enabled.
    const job = makeJob({ id: "my-job", enabled: false });
    const stillDisabled = makeJob({ id: "my-job", enabled: false });
    vi.mocked(cronStore.getJob).mockReturnValue(job);
    vi.mocked(cronStore.updateJob).mockReturnValue(stillDisabled);

    await app.request("/api/cron/jobs/my-job/toggle", { method: "POST" });

    // updated?.enabled is false, so stopJob is called instead of scheduleJob
    expect(scheduler.stopJob).toHaveBeenCalledWith("my-job");
    expect(scheduler.scheduleJob).not.toHaveBeenCalled();
  });
});

// ─── POST /api/cron/jobs/:id/run ────────────────────────────────────────────

describe("POST /api/cron/jobs/:id/run", () => {
  it("triggers a manual job run", async () => {
    const job = makeJob({ id: "runner" });
    vi.mocked(cronStore.getJob).mockReturnValue(job);

    const res = await app.request("/api/cron/jobs/runner/run", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toBe("Job triggered");
    expect(scheduler.executeJobManually).toHaveBeenCalledWith("runner");
  });

  it("returns 404 when job does not exist", async () => {
    vi.mocked(cronStore.getJob).mockReturnValue(null);

    const res = await app.request("/api/cron/jobs/nonexistent/run", { method: "POST" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Job not found");
  });

  it("triggers a run even for disabled jobs", async () => {
    // Manual run should work regardless of enabled state — the scheduler's
    // executeJobManually handles the force flag internally
    const job = makeJob({ id: "disabled-runner", enabled: false });
    vi.mocked(cronStore.getJob).mockReturnValue(job);

    const res = await app.request("/api/cron/jobs/disabled-runner/run", { method: "POST" });

    expect(res.status).toBe(200);
    expect(scheduler.executeJobManually).toHaveBeenCalledWith("disabled-runner");
  });
});

// ─── GET /api/cron/jobs/:id/executions ──────────────────────────────────────

describe("GET /api/cron/jobs/:id/executions", () => {
  it("returns an empty list when no executions exist", async () => {
    scheduler.getExecutions.mockReturnValue([]);

    const res = await app.request("/api/cron/jobs/test-job/executions");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
    expect(scheduler.getExecutions).toHaveBeenCalledWith("test-job");
  });

  it("returns the list of executions from the scheduler", async () => {
    const executions: CronJobExecution[] = [
      {
        sessionId: "sess-1",
        jobId: "test-job",
        startedAt: 1000,
        success: true,
      },
      {
        sessionId: "sess-2",
        jobId: "test-job",
        startedAt: 2000,
        completedAt: 2500,
        error: "CLI process failed",
      },
    ];
    scheduler.getExecutions.mockReturnValue(executions);

    const res = await app.request("/api/cron/jobs/test-job/executions");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(2);
    expect(json[0].sessionId).toBe("sess-1");
    expect(json[0].success).toBe(true);
    expect(json[1].error).toBe("CLI process failed");
  });

  it("returns empty array when scheduler is undefined", async () => {
    // When registerCronRoutes is called without a scheduler (undefined),
    // the optional chaining should safely return []
    const appNoScheduler = new Hono();
    const apiNoScheduler = new Hono();
    registerCronRoutes(apiNoScheduler, undefined);
    appNoScheduler.route("/api", apiNoScheduler);

    const res = await appNoScheduler.request("/api/cron/jobs/any-job/executions");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });
});

// ─── Scheduler-less mode (cronScheduler is undefined) ───────────────────────

describe("routes with undefined cronScheduler", () => {
  let appNoScheduler: Hono;

  beforeEach(() => {
    appNoScheduler = new Hono();
    const api = new Hono();
    registerCronRoutes(api, undefined);
    appNoScheduler.route("/api", api);
  });

  it("GET /cron/jobs returns jobs with nextRunAt: null", async () => {
    // When there's no scheduler, nextRunAt should always be null
    const job = makeJob();
    vi.mocked(cronStore.listJobs).mockReturnValue([job]);

    const res = await appNoScheduler.request("/api/cron/jobs");

    const json = await res.json();
    expect(json[0].nextRunAt).toBeNull();
  });

  it("GET /cron/jobs/:id returns job with nextRunAt: null", async () => {
    const job = makeJob({ id: "test" });
    vi.mocked(cronStore.getJob).mockReturnValue(job);

    const res = await appNoScheduler.request("/api/cron/jobs/test");

    const json = await res.json();
    expect(json.nextRunAt).toBeNull();
  });

  it("POST /cron/jobs creates job without calling scheduleJob", async () => {
    const created = makeJob({ enabled: true });
    vi.mocked(cronStore.createJob).mockReturnValue(created);

    const res = await appNoScheduler.request("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Job",
        prompt: "Do stuff",
        schedule: "0 * * * *",
        cwd: "/tmp",
      }),
    });

    // Should still succeed — optional chaining means no error
    expect(res.status).toBe(201);
  });

  it("PUT /cron/jobs/:id updates job without calling scheduleJob", async () => {
    const updated = makeJob({ id: "test-job" });
    vi.mocked(cronStore.updateJob).mockReturnValue(updated);

    const res = await appNoScheduler.request("/api/cron/jobs/test-job", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });

    expect(res.status).toBe(200);
  });

  it("DELETE /cron/jobs/:id deletes job without calling stopJob", async () => {
    vi.mocked(cronStore.deleteJob).mockReturnValue(true);

    const res = await appNoScheduler.request("/api/cron/jobs/test-job", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
  });

  it("POST /cron/jobs/:id/toggle works without scheduler", async () => {
    const job = makeJob({ id: "test", enabled: true });
    const toggled = makeJob({ id: "test", enabled: false });
    vi.mocked(cronStore.getJob).mockReturnValue(job);
    vi.mocked(cronStore.updateJob).mockReturnValue(toggled);

    const res = await appNoScheduler.request("/api/cron/jobs/test/toggle", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enabled).toBe(false);
  });

  it("POST /cron/jobs/:id/run works without scheduler", async () => {
    const job = makeJob({ id: "test" });
    vi.mocked(cronStore.getJob).mockReturnValue(job);

    const res = await appNoScheduler.request("/api/cron/jobs/test/run", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});
