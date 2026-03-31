/**
 * mcp-routes.ts — Register the MCP HTTP endpoint for agent tool access.
 *
 * Exposes POST /mcp which accepts JSON-RPC 2.0 requests from Claude Code
 * and Codex agents via the MCP HTTP protocol.
 */

import type { Hono } from "hono";
import type { WsBridge } from "../ws-bridge.js";
import type { CliLauncher } from "../cli-launcher.js";
import { verifyToken } from "../auth-manager.js";
import { handleMcpRequest } from "../mcp-server.js";

/**
 * Check if the request originates from localhost (Bun-specific requestIP).
 * Duplicated from routes.ts to keep the MCP route self-contained.
 */
function isLocalhostRequest(c: { env: unknown; req: { raw: Request } }): boolean {
  const bunServer = c.env as { requestIP?: (req: Request) => { address: string } | null };
  const ip = bunServer?.requestIP?.(c.req.raw);
  const addr = ip?.address ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function registerMcpRoutes(
  api: Hono,
  wsBridge: WsBridge,
  launcher: CliLauncher,
): void {
  api.post("/mcp", async (c) => {
    // MCP-specific auth: accept token in query param for containerized agents
    // that can't set custom headers. This is intentionally NOT in the global
    // middleware to limit the attack surface to this single endpoint.
    if (!isLocalhostRequest(c)) {
      const queryToken = c.req.query("token") ?? null;
      const authHeader = c.req.header("Authorization");
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!verifyToken(bearerToken) && !verifyToken(queryToken)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

    const sessionId = c.req.query("sessionId") ?? null;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    // Basic JSON-RPC shape validation
    const rpc = body as Record<string, unknown>;
    if (!rpc || typeof rpc !== "object" || rpc.jsonrpc !== "2.0") {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } },
        400,
      );
    }

    const response = await handleMcpRequest(
      body as Parameters<typeof handleMcpRequest>[0],
      sessionId,
      { wsBridge, launcher },
    );

    return c.json(response);
  });
}
