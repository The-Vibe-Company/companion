import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock sandbox-manager ─────────────────────────────────────────────────
vi.mock("../sandbox-manager.js", () => ({
  listSandboxes: vi.fn(() => []),
  getSandbox: vi.fn(() => null),
  createSandbox: vi.fn(),
  updateSandbox: vi.fn(),
  deleteSandbox: vi.fn(() => false),
}));

// ─── Mock container-manager ───────────────────────────────────────────────
vi.mock("../container-manager.js", () => ({
  containerManager: {
    checkDocker: vi.fn(() => true),
    createContainer: vi.fn(() => ({ containerId: "test-container-123", name: "companion-test" })),
    copyWorkspaceToContainer: vi.fn(async () => {}),
    execInContainerAsync: vi.fn(async () => ({ exitCode: 0, output: "ok\n" })),
    removeContainer: vi.fn(),
  },
}));

// ─── Mock image-pull-manager ──────────────────────────────────────────────
vi.mock("../image-pull-manager.js", () => ({
  imagePullManager: {
    isReady: vi.fn(() => true),
  },
}));

import { Hono } from "hono";
import * as sandboxManager from "../sandbox-manager.js";
import { containerManager } from "../container-manager.js";
import { imagePullManager } from "../image-pull-manager.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";

// ─── Test setup ───────────────────────────────────────────────────────────

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();

  app = new Hono().basePath("/api");
  registerSandboxRoutes(app);
});

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Minimal sandbox fixture matching the CompanionSandbox shape. */
function makeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    name: "My Sandbox",
    slug: "my-sandbox",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sandboxes
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/sandboxes", () => {
  it("returns an empty list when no sandboxes exist", async () => {
    // Validates that the endpoint returns 200 with an empty array
    // when there are no sandboxes on disk.
    vi.mocked(sandboxManager.listSandboxes).mockReturnValue([]);

    const res = await app.request("/api/sandboxes");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns a list of sandboxes", async () => {
    // Validates that multiple sandboxes are returned correctly.
    const sandboxes = [
      makeSandbox(),
      makeSandbox({ slug: "second", name: "Second" }),
    ];
    vi.mocked(sandboxManager.listSandboxes).mockReturnValue(sandboxes as any);

    const res = await app.request("/api/sandboxes");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(2);
    expect(json[0].slug).toBe("my-sandbox");
    expect(json[1].slug).toBe("second");
  });

  it("returns 500 when listSandboxes throws", async () => {
    // Validates that internal errors in sandbox-manager are surfaced
    // as 500 responses with the error message in the body.
    vi.mocked(sandboxManager.listSandboxes).mockImplementation(() => {
      throw new Error("disk failure");
    });

    const res = await app.request("/api/sandboxes");

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("disk failure");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/sandboxes/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/sandboxes/:slug", () => {
  it("returns the sandbox when it exists", async () => {
    // Validates that a single sandbox is returned by slug and that
    // getSandbox is called with the correct slug parameter.
    const sandbox = makeSandbox();
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);

    const res = await app.request("/api/sandboxes/my-sandbox");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sandbox);
    expect(sandboxManager.getSandbox).toHaveBeenCalledWith("my-sandbox");
  });

  it("returns 404 when the sandbox does not exist", async () => {
    // Validates that requesting a non-existent slug returns 404
    // with an appropriate error message.
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(null);

    const res = await app.request("/api/sandboxes/missing");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sandboxes
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/sandboxes", () => {
  it("creates a sandbox with name and initScript and returns 201", async () => {
    // Validates that a new sandbox is created with optional initScript
    // and that the response status is 201 (Created).
    const created = makeSandbox({
      initScript: "npm install",
    });
    vi.mocked(sandboxManager.createSandbox).mockReturnValue(created as any);

    const res = await app.request("/api/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My Sandbox",
        initScript: "npm install",
      }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
    // Verify createSandbox was called with name and options object
    expect(sandboxManager.createSandbox).toHaveBeenCalledWith("My Sandbox", {
      initScript: "npm install",
    });
  });

  it("returns 400 when createSandbox throws a validation error", async () => {
    // Validates that errors thrown by createSandbox (e.g. duplicate slug)
    // are surfaced as 400 responses with the error message.
    vi.mocked(sandboxManager.createSandbox).mockImplementation(() => {
      throw new Error('A sandbox with a similar name already exists ("my-sandbox")');
    });

    const res = await app.request("/api/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Sandbox" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/already exists/i);
  });

  it("returns 400 when name is missing", async () => {
    // Validates that omitting the required "name" field causes a 400 error.
    // The sandbox-manager throws "Sandbox name is required" for empty names.
    vi.mocked(sandboxManager.createSandbox).mockImplementation(() => {
      throw new Error("Sandbox name is required");
    });

    const res = await app.request("/api/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Sandbox name is required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /api/sandboxes/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("PUT /api/sandboxes/:slug", () => {
  it("updates an existing sandbox", async () => {
    // Validates that an existing sandbox can be updated with new fields
    // and that updateSandbox is called with the correct slug and update payload.
    const updated = makeSandbox({ name: "Updated Name" });
    vi.mocked(sandboxManager.updateSandbox).mockReturnValue(updated as any);

    const res = await app.request("/api/sandboxes/my-sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Name", initScript: "echo hi" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(updated);
    expect(sandboxManager.updateSandbox).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ name: "Updated Name", initScript: "echo hi" }),
    );
  });

  it("returns 404 when the sandbox does not exist", async () => {
    // Validates that updating a non-existent sandbox returns 404.
    // updateSandbox returns null when the slug is not found.
    vi.mocked(sandboxManager.updateSandbox).mockReturnValue(null);

    const res = await app.request("/api/sandboxes/missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it("returns 400 when updateSandbox throws a slug collision error", async () => {
    // Validates that renaming a sandbox to a name that collides with
    // an existing slug results in a 400 error.
    vi.mocked(sandboxManager.updateSandbox).mockImplementation(() => {
      throw new Error('A sandbox with a similar name already exists ("other-sandbox")');
    });

    const res = await app.request("/api/sandboxes/my-sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Other Sandbox" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/already exists/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/sandboxes/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("DELETE /api/sandboxes/:slug", () => {
  it("deletes a sandbox and returns ok", async () => {
    // Validates successful deletion returns { ok: true } and that
    // deleteSandbox is called with the correct slug.
    vi.mocked(sandboxManager.deleteSandbox).mockReturnValue(true);

    const res = await app.request("/api/sandboxes/my-sandbox", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sandboxManager.deleteSandbox).toHaveBeenCalledWith("my-sandbox");
  });

  it("returns 404 when the sandbox does not exist", async () => {
    // Validates that deleting a non-existent sandbox returns 404.
    vi.mocked(sandboxManager.deleteSandbox).mockReturnValue(false);

    const res = await app.request("/api/sandboxes/missing", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/sandboxes/:slug/test-init
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/sandboxes/:slug/test-init", () => {
  it("executes the init script in an ephemeral container and returns success", async () => {
    // Happy path: sandbox exists, has init script, Docker available, image ready.
    // Should create container, copy workspace, exec script, cleanup.
    const sandbox = makeSandbox({ initScript: "echo hello" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(imagePullManager.isReady).mockReturnValue(true);
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({
      exitCode: 0,
      output: "hello\n",
    });

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/home/user/project" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.exitCode).toBe(0);
    expect(json.output).toBe("hello\n");

    // Container should be cleaned up
    expect(containerManager.removeContainer).toHaveBeenCalled();
  });

  it("returns 404 when sandbox not found", async () => {
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(null);

    const res = await app.request("/api/sandboxes/missing/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 when sandbox has no init script", async () => {
    // A sandbox without an init script cannot be tested
    const sandbox = makeSandbox(); // no initScript
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no init script/i);
  });

  it("returns 400 when cwd is missing", async () => {
    const sandbox = makeSandbox({ initScript: "echo test" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/cwd/i);
  });

  it("returns 503 when Docker is not available", async () => {
    const sandbox = makeSandbox({ initScript: "echo test" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);
    vi.mocked(containerManager.checkDocker).mockReturnValue(false);

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/docker/i);
  });

  it("returns 503 when Docker image is not ready", async () => {
    const sandbox = makeSandbox({ initScript: "echo test" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(imagePullManager.isReady).mockReturnValue(false);

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/not available/i);
  });

  it("returns failure when init script exits with non-zero code", async () => {
    // The init script failed — report the exit code and captured output
    const sandbox = makeSandbox({ initScript: "exit 1" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(imagePullManager.isReady).mockReturnValue(true);
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({
      exitCode: 1,
      output: "command not found\n",
    });

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.exitCode).toBe(1);
    expect(json.output).toContain("command not found");

    // Container should still be cleaned up
    expect(containerManager.removeContainer).toHaveBeenCalled();
  });

  it("cleans up container even when execInContainerAsync throws", async () => {
    // Ensures the finally block removes the container on unexpected errors
    const sandbox = makeSandbox({ initScript: "echo crash" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(imagePullManager.isReady).mockReturnValue(true);
    vi.mocked(containerManager.execInContainerAsync).mockRejectedValue(
      new Error("Container crashed"),
    );

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.output).toBe("Container crashed");

    // Container should be cleaned up even on error
    expect(containerManager.removeContainer).toHaveBeenCalled();
  });

  it("uses body initScript over stored initScript when provided", async () => {
    // The endpoint accepts an optional initScript body param so the frontend
    // can test unsaved draft content without persisting first.
    const sandbox = makeSandbox({ initScript: "stored script" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(imagePullManager.isReady).mockReturnValue(true);
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({
      exitCode: 0,
      output: "draft ok\n",
    });

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp", initScript: "echo draft" }),
    });

    expect(res.status).toBe(200);
    // Should exec the body initScript, not the stored one
    expect(containerManager.execInContainerAsync).toHaveBeenCalledWith(
      "test-container-123",
      ["sh", "-lc", "echo draft"],
      expect.any(Object),
    );
  });

  it("normalizes cwd to prevent path traversal", async () => {
    // The cwd should be resolved to an absolute path to collapse
    // traversal sequences like ../../etc.
    const sandbox = makeSandbox({ initScript: "echo test" });
    vi.mocked(sandboxManager.getSandbox).mockReturnValue(sandbox as any);
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(imagePullManager.isReady).mockReturnValue(true);
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValue({
      exitCode: 0,
      output: "ok\n",
    });

    const res = await app.request("/api/sandboxes/my-sandbox/test-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/home/user/../../../etc" }),
    });

    expect(res.status).toBe(200);
    // The cwd passed to createContainer should be the resolved path
    expect(containerManager.createContainer).toHaveBeenCalledWith(
      expect.any(String),
      "/etc",
      expect.any(Object),
    );
  });
});
