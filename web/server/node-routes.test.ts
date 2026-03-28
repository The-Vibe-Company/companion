import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock settings-manager before importing the routes
// vi.hoisted ensures the variables exist when vi.mock factory runs (hoisted to top)
const { mockGetNodes, mockGetNode, mockAddNode, mockUpdateNode, mockRemoveNode } = vi.hoisted(() => ({
  mockGetNodes: vi.fn(() => [] as any[]),
  mockGetNode: vi.fn(() => undefined as any),
  mockAddNode: vi.fn(),
  mockUpdateNode: vi.fn(() => ({ id: "test", name: "Test", url: "http://test", authToken: "tok", enabled: true })),
  mockRemoveNode: vi.fn(),
}));

vi.mock("./settings-manager.js", () => ({
  getNodes: mockGetNodes,
  getNode: mockGetNode,
  addNode: mockAddNode,
  updateNode: mockUpdateNode,
  removeNode: mockRemoveNode,
}));

import { nodeRoutes } from "./node-routes.js";
import { Hono } from "hono";

// Mount routes under /api/nodes like the real server does
const app = new Hono();
app.route("/api/nodes", nodeRoutes);

/**
 * Helper to make requests against the Hono app.
 * Hono is strict about trailing slashes: /api/nodes/ ≠ /api/nodes.
 * The sub-router defines routes as "/" which maps to "/api/nodes" (no trailing slash).
 */
function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  // path="/" means root of the sub-router → /api/nodes (no trailing slash)
  const fullPath = path === "/" ? "/api/nodes" : `/api/nodes${path}`;
  return app.request(fullPath, init);
}

describe("node-routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /api/nodes ──────────────────────────────────────────────────────────

  describe("GET /", () => {
    it("should_return_empty_array_when_no_nodes_exist", async () => {
      mockGetNodes.mockReturnValue([]);
      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("should_strip_authToken_and_add_hasToken_when_nodes_exist", async () => {
      // Verifies that auth tokens are never sent to the browser
      mockGetNodes.mockReturnValue([
        { id: "n1", name: "Node 1", url: "http://node1", authToken: "secret-token-123", enabled: true },
        { id: "n2", name: "Node 2", url: "http://node2", authToken: "another-secret", enabled: false },
      ]);
      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(2);
      // authToken must be stripped; hasToken must be added
      expect(data[0]).toEqual({ id: "n1", name: "Node 1", url: "http://node1", enabled: true, hasToken: true });
      expect(data[1]).toEqual({ id: "n2", name: "Node 2", url: "http://node2", enabled: false, hasToken: true });
      // Double-check: no authToken leak
      expect(data[0].authToken).toBeUndefined();
      expect(data[1].authToken).toBeUndefined();
    });
  });

  // ── POST /api/nodes ─────────────────────────────────────────────────────────

  describe("POST /", () => {
    it("should_create_node_when_valid_body_provided", async () => {
      const res = await req("POST", "/", { name: "My Node", url: "http://my-node:3456/", authToken: "tok123" });
      expect(res.status).toBe(201);
      const data = await res.json();
      // ID is derived from name: lowercase, non-alphanum → hyphen, trimmed
      expect(data.id).toBe("my-node");
      expect(data.name).toBe("My Node");
      // Trailing slash stripped from url
      expect(data.url).toBe("http://my-node:3456");
      expect(data.hasToken).toBe(true);
      expect(data.enabled).toBe(true);
      // addNode should have been called with the full NodeConfig (including authToken)
      expect(mockAddNode).toHaveBeenCalledWith({
        id: "my-node",
        name: "My Node",
        url: "http://my-node:3456",
        authToken: "tok123",
        enabled: true,
      });
    });

    it("should_return_400_when_name_missing", async () => {
      const res = await req("POST", "/", { url: "http://x", authToken: "t" });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("required");
    });

    it("should_return_400_when_url_missing", async () => {
      const res = await req("POST", "/", { name: "X", authToken: "t" });
      expect(res.status).toBe(400);
    });

    it("should_return_400_when_authToken_missing", async () => {
      const res = await req("POST", "/", { name: "X", url: "http://x" });
      expect(res.status).toBe(400);
    });

    it("should_return_400_when_body_is_invalid_json", async () => {
      // Send a non-JSON body — use /api/nodes without trailing slash (Hono strict matching)
      const res = await app.request("/api/nodes", {
        method: "POST",
        body: "not-json",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("should_return_400_when_name_produces_empty_id", async () => {
      // A name of only special characters produces an empty slug
      const res = await req("POST", "/", { name: "!!!@@@", url: "http://x", authToken: "t" });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid name");
    });

    it("should_return_409_when_addNode_throws_duplicate", async () => {
      mockAddNode.mockImplementation(() => {
        throw new Error("Node with id already exists");
      });
      const res = await req("POST", "/", { name: "Dupe", url: "http://x", authToken: "t" });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already exists");
    });
  });

  // ── PUT /api/nodes/:id ──────────────────────────────────────────────────────

  describe("PUT /:id", () => {
    it("should_update_node_when_valid_patch_provided", async () => {
      mockUpdateNode.mockReturnValue({
        id: "my-node", name: "Updated", url: "http://updated", authToken: "secret", enabled: true,
      });
      const res = await req("PUT", "/my-node", { name: "Updated" });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("Updated");
      expect(data.hasToken).toBe(true);
      // authToken must not leak
      expect(data.authToken).toBeUndefined();
    });

    it("should_strip_trailing_slashes_from_url_in_patch", async () => {
      mockUpdateNode.mockReturnValue({
        id: "n1", name: "N1", url: "http://clean", authToken: "t", enabled: true,
      });
      await req("PUT", "/n1", { url: "http://clean///" });
      // The route strips trailing slashes before calling updateNode
      expect(mockUpdateNode).toHaveBeenCalledWith("n1", { url: "http://clean" });
    });

    it("should_return_400_when_body_is_invalid", async () => {
      const res = await app.request("/api/nodes/n1", {
        method: "PUT",
        body: "{{bad",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("should_return_404_when_node_not_found", async () => {
      mockUpdateNode.mockImplementation(() => {
        throw new Error("Node not found");
      });
      const res = await req("PUT", "/nonexistent", { name: "X" });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/nodes/:id ───────────────────────────────────────────────────

  describe("DELETE /:id", () => {
    it("should_delete_node_when_exists", async () => {
      const res = await req("DELETE", "/my-node");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mockRemoveNode).toHaveBeenCalledWith("my-node");
    });

    it("should_return_404_when_node_not_found", async () => {
      mockRemoveNode.mockImplementation(() => {
        throw new Error("Node not found");
      });
      const res = await req("DELETE", "/ghost");
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/nodes/:id/health ──────────────────────────────────────────────

  describe("POST /:id/health", () => {
    it("should_return_404_when_node_not_found", async () => {
      mockGetNode.mockReturnValue(undefined);
      const res = await req("POST", "/missing/health");
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("not found");
    });

    it("should_return_ok_true_when_remote_health_succeeds", async () => {
      mockGetNode.mockReturnValue({ id: "n1", url: "http://remote:3456", authToken: "t" });
      // Mock global fetch to simulate healthy remote node
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, uptime: 12345, sessions: 3 }),
      });

      const res = await req("POST", "/n1/health");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.uptime).toBe(12345);
      expect(data.sessions).toBe(3);

      globalThis.fetch = originalFetch;
    });

    it("should_return_ok_false_when_remote_returns_non_ok_status", async () => {
      mockGetNode.mockReturnValue({ id: "n1", url: "http://remote:3456", authToken: "t" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

      const res = await req("POST", "/n1/health");
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain("503");

      globalThis.fetch = originalFetch;
    });

    it("should_return_timeout_error_when_fetch_aborts", async () => {
      mockGetNode.mockReturnValue({ id: "n1", url: "http://remote:3456", authToken: "t" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("The operation was aborted"));

      const res = await req("POST", "/n1/health");
      const data = await res.json();
      expect(data.ok).toBe(false);
      // The route transforms abort errors to "Timeout (5s)"
      expect(data.error).toContain("Timeout");

      globalThis.fetch = originalFetch;
    });

    it("should_return_error_message_when_fetch_fails_with_network_error", async () => {
      mockGetNode.mockReturnValue({ id: "n1", url: "http://remote:3456", authToken: "t" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const res = await req("POST", "/n1/health");
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain("ECONNREFUSED");

      globalThis.fetch = originalFetch;
    });
  });
});
