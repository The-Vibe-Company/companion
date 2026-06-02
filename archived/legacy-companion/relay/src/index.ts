/**
 * Companion Relay Worker
 *
 * A Cloudflare Worker that acts as a webhook relay for The Companion app.
 * The Companion runs behind a firewall but needs to receive external platform
 * webhooks (e.g. from Linear, GitHub, etc.).
 *
 * Architecture:
 *   Platform --> POST /webhooks/:platform --> Relay Worker
 *     | (WebSocket)
 *   Companion relay-client receives webhook request
 *     | (local)
 *   Companion processes the webhook
 *     | (WebSocket)
 *   Relay Worker receives response
 *     | (HTTP)
 *   Platform gets the response
 */

export interface Env {
  RELAY_SECRET: string;
}

/** Pending webhook request awaiting a response from the Companion. */
interface PendingRequest {
  resolve: (response: WebhookResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Message sent from the Relay to the Companion over WebSocket. */
interface WebhookRequest {
  type: "webhook_request";
  requestId: string;
  platform: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Message sent from the Companion to the Relay over WebSocket. */
interface WebhookResponse {
  type: "webhook_response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// In-memory state (per worker isolate)
// ---------------------------------------------------------------------------
// NOTE: These globals are scoped to a single Cloudflare Worker isolate.
// Under high load or rolling deployments, multiple isolates may run
// concurrently, each with independent copies of these variables. For
// production-grade reliability, migrate to a Cloudflare Durable Object
// so WebSocket state is shared across all isolates. The current approach
// works when all traffic routes to the same isolate (typical for low-
// traffic single-tenant deployments).
// ---------------------------------------------------------------------------

/** The active WebSocket connection from the Companion client. */
let companionSocket: WebSocket | null = null;

/** Map of requestId -> pending promise for webhook responses. */
const pendingRequests = new Map<string, PendingRequest>();

/** Timeout in milliseconds for webhook request/response round-trips. */
const WEBHOOK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison to avoid timing side-channel leaks.
 * Uses the Web Crypto subtle API available in Workers to compare via
 * SHA-256 digests, which avoids early-exit on mismatch.
 */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  if (viewA.length !== viewB.length) return false;
  let result = 0;
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i] ^ viewB[i];
  }
  return result === 0;
}

/** Build a JSON Response with the given status code. */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /health — returns whether the Companion is connected. */
function handleHealth(): Response {
  return jsonResponse({
    connected: companionSocket !== null && companionSocket.readyState === WebSocket.OPEN,
  });
}

/**
 * GET /ws/relay?secret=... — WebSocket upgrade for the Companion client.
 *
 * The Companion connects here and keeps an open WebSocket to receive
 * webhook requests and send back responses.
 */
async function handleRelayWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "Expected WebSocket upgrade" }, 426);
  }

  // Authenticate using the shared secret.
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? "";
  if (!env.RELAY_SECRET || !(await secretsMatch(secret, env.RELAY_SECRET))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Create the WebSocket pair.
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];

  // Accept the server-side socket.
  server.accept();

  // If there is an existing Companion connection, close it gracefully.
  if (companionSocket !== null) {
    try {
      companionSocket.close(1000, "Replaced by new connection");
    } catch {
      // Ignore errors on already-closed sockets.
    }
  }

  companionSocket = server;

  server.addEventListener("message", (event: MessageEvent) => {
    try {
      const data: WebhookResponse = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
      );

      if (data.type === "webhook_response" && data.requestId) {
        const pending = pendingRequests.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(data.requestId);
          pending.resolve(data);
        }
      }
    } catch {
      // Ignore malformed messages.
    }
  });

  server.addEventListener("close", () => {
    if (companionSocket === server) {
      companionSocket = null;
    }
    // Reject all pending requests that were relying on this connection.
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Companion disconnected"));
      pendingRequests.delete(id);
    }
  });

  server.addEventListener("error", () => {
    if (companionSocket === server) {
      companionSocket = null;
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * POST /webhooks/:platform — receives an external platform webhook.
 *
 * Forwards the request to the connected Companion via WebSocket and waits
 * up to 30 seconds for the Companion to process it and respond.
 */
async function handleWebhook(request: Request, platform: string): Promise<Response> {
  // Verify the Companion is connected.
  if (!companionSocket || companionSocket.readyState !== WebSocket.OPEN) {
    return jsonResponse({ error: "Companion not connected" }, 503);
  }

  const requestId = crypto.randomUUID();

  // Read the incoming request body as text.
  const body = await request.text();

  // Collect headers into a plain object.
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Build the relay message.
  const message: WebhookRequest = {
    type: "webhook_request",
    requestId,
    platform,
    method: "POST",
    headers,
    body,
  };

  // Create a promise that resolves when the Companion responds.
  const responsePromise = new Promise<WebhookResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Timeout waiting for Companion response"));
    }, WEBHOOK_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, reject, timer });
  });

  // Send the webhook request to the Companion.
  try {
    companionSocket.send(JSON.stringify(message));
  } catch {
    pendingRequests.delete(requestId);
    return jsonResponse({ error: "Failed to send to Companion" }, 502);
  }

  // Wait for the Companion to respond (or timeout).
  try {
    const webhookResponse = await responsePromise;

    const responseHeaders = new Headers();
    if (webhookResponse.headers) {
      for (const [key, value] of Object.entries(webhookResponse.headers)) {
        responseHeaders.set(key, value);
      }
    }

    return new Response(webhookResponse.body ?? "", {
      status: webhookResponse.status ?? 200,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Timeout")) {
      return jsonResponse({ error: "Gateway timeout waiting for Companion" }, 504);
    }
    return jsonResponse({ error: message }, 502);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Simple path-based router. */
function matchRoute(
  method: string,
  pathname: string,
): { handler: string; params?: Record<string, string> } | null {
  if (method === "GET" && pathname === "/health") {
    return { handler: "health" };
  }
  if (method === "GET" && pathname === "/ws/relay") {
    return { handler: "relay" };
  }
  // Match POST /webhooks/:platform
  const webhookMatch = pathname.match(/^\/webhooks\/([a-zA-Z0-9_-]+)$/);
  if (method === "POST" && webhookMatch) {
    return { handler: "webhook", params: { platform: webhookMatch[1] } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);

    if (!route) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    switch (route.handler) {
      case "health":
        return handleHealth();
      case "relay":
        return handleRelayWebSocket(request, env);
      case "webhook":
        return handleWebhook(request, route.params!.platform);
      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
