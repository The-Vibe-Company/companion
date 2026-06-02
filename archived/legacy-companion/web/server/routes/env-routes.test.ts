import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock env-manager ──────────────────────────────────────────────────────
vi.mock("../env-manager.js", () => ({
  listEnvs: vi.fn(() => []),
  getEnv: vi.fn(() => null),
  createEnv: vi.fn(),
  updateEnv: vi.fn(),
  deleteEnv: vi.fn(() => false),
}));

// ─── Mock container-manager ────────────────────────────────────────────────
vi.mock("../container-manager.js", () => ({
  containerManager: {
    checkDocker: vi.fn(() => true),
    buildImageStreaming: vi.fn(async () => ({ success: true, log: "Built" })),
    buildImage: vi.fn(() => "ok"),
    imageExists: vi.fn(() => false),
  },
}));

// ─── Mock image-pull-manager ───────────────────────────────────────────────
vi.mock("../image-pull-manager.js", () => ({
  imagePullManager: {
    getState: vi.fn((tag: string) => ({ image: tag, status: "idle", progress: [] })),
    pull: vi.fn(),
  },
}));

// ─── Mock node:fs (only existsSync is used by the route) ──────────────────
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));

import { Hono } from "hono";
import * as envManager from "../env-manager.js";
import { containerManager } from "../container-manager.js";
import { imagePullManager } from "../image-pull-manager.js";
import { existsSync } from "node:fs";
import { registerEnvRoutes } from "./env-routes.js";

// ─── Test setup ────────────────────────────────────────────────────────────

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();

  app = new Hono();
  const api = new Hono();
  registerEnvRoutes(api, { webDir: "/fake/web" });
  app.route("/api", api);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Minimal env fixture matching the CompanionEnv shape. */
function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Env",
    slug: "test-env",
    variables: { FOO: "bar" },
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/envs
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/envs", () => {
  it("returns an empty list when no environments exist", async () => {
    vi.mocked(envManager.listEnvs).mockReturnValue([]);

    const res = await app.request("/api/envs");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns a list of environments", async () => {
    const envs = [makeEnv(), makeEnv({ slug: "second", name: "Second" })];
    vi.mocked(envManager.listEnvs).mockReturnValue(envs as any);

    const res = await app.request("/api/envs");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(2);
    expect(json[0].slug).toBe("test-env");
  });

  it("returns 500 when listEnvs throws", async () => {
    vi.mocked(envManager.listEnvs).mockImplementation(() => {
      throw new Error("disk failure");
    });

    const res = await app.request("/api/envs");

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("disk failure");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/envs/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/envs/:slug", () => {
  it("returns the environment when it exists", async () => {
    const env = makeEnv();
    vi.mocked(envManager.getEnv).mockReturnValue(env as any);

    const res = await app.request("/api/envs/test-env");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(env);
    expect(envManager.getEnv).toHaveBeenCalledWith("test-env");
  });

  it("returns 404 when the environment does not exist", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue(null as any);

    const res = await app.request("/api/envs/missing");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/envs
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/envs", () => {
  it("creates a new environment and returns 201", async () => {
    const created = makeEnv();
    vi.mocked(envManager.createEnv).mockReturnValue(created as any);

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Env", variables: { FOO: "bar" } }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
    // Verify createEnv was called with the correct arguments (name + variables only)
    expect(envManager.createEnv).toHaveBeenCalledWith(
      "Test Env",
      { FOO: "bar" },
    );
  });

  it("returns 400 when createEnv throws a validation error", async () => {
    vi.mocked(envManager.createEnv).mockImplementation(() => {
      throw new Error("Name is required");
    });

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Name is required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /api/envs/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("PUT /api/envs/:slug", () => {
  it("updates an existing environment", async () => {
    const updated = makeEnv({ name: "Updated" });
    vi.mocked(envManager.updateEnv).mockReturnValue(updated as any);

    const res = await app.request("/api/envs/test-env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(updated);
    expect(envManager.updateEnv).toHaveBeenCalledWith(
      "test-env",
      expect.objectContaining({ name: "Updated" }),
    );
  });

  it("returns 404 when the environment does not exist", async () => {
    vi.mocked(envManager.updateEnv).mockReturnValue(null as any);

    const res = await app.request("/api/envs/missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it("returns 400 when updateEnv throws", async () => {
    vi.mocked(envManager.updateEnv).mockImplementation(() => {
      throw new Error("Invalid slug");
    });

    const res = await app.request("/api/envs/test-env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/envs/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("DELETE /api/envs/:slug", () => {
  it("deletes an environment and returns ok", async () => {
    vi.mocked(envManager.deleteEnv).mockReturnValue(true);

    const res = await app.request("/api/envs/test-env", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(envManager.deleteEnv).toHaveBeenCalledWith("test-env");
  });

  it("returns 404 when the environment does not exist", async () => {
    vi.mocked(envManager.deleteEnv).mockReturnValue(false);

    const res = await app.request("/api/envs/missing", { method: "DELETE" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/docker/build-base
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/docker/build-base", () => {
  it("builds the base image successfully when Docker and Dockerfile exist", async () => {
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(containerManager.buildImage).mockReturnValue("build log");

    const res = await app.request("/api/docker/build-base", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.log).toBe("build log");
  });

  it("returns 503 when Docker is not available", async () => {
    vi.mocked(containerManager.checkDocker).mockReturnValue(false);

    const res = await app.request("/api/docker/build-base", { method: "POST" });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/docker/i);
  });

  it("returns 404 when the base Dockerfile does not exist on disk", async () => {
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(existsSync).mockReturnValue(false);

    const res = await app.request("/api/docker/build-base", { method: "POST" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/dockerfile/i);
  });

  it("returns 500 when buildImage throws", async () => {
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(containerManager.buildImage).mockImplementation(() => {
      throw new Error("out of disk space");
    });

    const res = await app.request("/api/docker/build-base", { method: "POST" });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("out of disk space");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/docker/base-image
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/docker/base-image", () => {
  it("returns exists: false when the base image is not built", async () => {
    vi.mocked(containerManager.imageExists).mockReturnValue(false);

    const res = await app.request("/api/docker/base-image");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.exists).toBe(false);
    expect(json.image).toBe("the-companion:latest");
  });

  it("returns exists: true when the base image is present", async () => {
    vi.mocked(containerManager.imageExists).mockReturnValue(true);

    const res = await app.request("/api/docker/base-image");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.exists).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/images/:tag/status
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/images/:tag/status", () => {
  it("returns idle state for a tag that has not been pulled", async () => {
    const state = { image: "node:20", status: "idle", progress: [] };
    vi.mocked(imagePullManager.getState).mockReturnValue(state as any);

    const res = await app.request("/api/images/node%3A20/status");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.image).toBe("node:20");
    expect(json.status).toBe("idle");
    expect(imagePullManager.getState).toHaveBeenCalledWith("node:20");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/images/:tag/pull
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/images/:tag/pull", () => {
  it("starts pulling an image and returns ok with the current state", async () => {
    vi.mocked(containerManager.checkDocker).mockReturnValue(true);
    const state = { image: "node:20", status: "pulling", progress: [] };
    vi.mocked(imagePullManager.getState).mockReturnValue(state as any);

    const res = await app.request("/api/images/node%3A20/pull", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.state.status).toBe("pulling");
    expect(imagePullManager.pull).toHaveBeenCalledWith("node:20");
  });

  it("returns 503 when Docker is not available", async () => {
    vi.mocked(containerManager.checkDocker).mockReturnValue(false);

    const res = await app.request("/api/images/node%3A20/pull", { method: "POST" });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/docker/i);
  });
});
