// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { registerMcpRoutes } from "./mcp-routes.js";

// Mock auth — in tests, requestIP is undefined so isLocalhostRequest returns false.
// Mock verifyToken to simulate authenticated requests.
vi.mock("../auth-manager.js", () => ({
  verifyToken: vi.fn().mockReturnValue(true),
}));

// Mock the MCP server handler so we don't need full deps
vi.mock("../mcp-server.js", () => ({
  handleMcpRequest: vi.fn().mockResolvedValue({
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2024-11-05" },
  }),
}));

import { verifyToken } from "../auth-manager.js";
import { handleMcpRequest } from "../mcp-server.js";
const mockVerifyToken = vi.mocked(verifyToken);
const mockHandleMcpRequest = vi.mocked(handleMcpRequest);

describe("MCP Routes — POST /mcp", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default mock behavior after clearAllMocks
    mockVerifyToken.mockReturnValue(true);
    mockHandleMcpRequest.mockResolvedValue({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2024-11-05" },
    });

    app = new Hono();
    const wsBridge = {} as any;
    const launcher = {} as any;
    registerMcpRoutes(app, wsBridge, launcher);
  });

  it("dispatches valid JSON-RPC request to handler", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(mockHandleMcpRequest).toHaveBeenCalledOnce();
  });

  it("passes sessionId from query param to handler", async () => {
    await app.request("/mcp?sessionId=test-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(mockHandleMcpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "tools/list" }),
      "test-session",
      expect.any(Object),
    );
  });

  it("passes null sessionId when query param is absent", async () => {
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(mockHandleMcpRequest).toHaveBeenCalledWith(
      expect.any(Object),
      null,
      expect.any(Object),
    );
  });

  it("returns 400 for malformed JSON body", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toContain("Parse error");
  });

  it("returns 400 for non-JSON-RPC request (missing jsonrpc field)", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, method: "initialize" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("Invalid JSON-RPC");
  });

  it("returns 401 when auth fails for non-localhost requests", async () => {
    // Simulate failed auth — no valid token provided
    mockVerifyToken.mockReturnValue(false);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(res.status).toBe(401);
  });
});
