// ─── Relay Client ────────────────────────────────────────────────────────────
// Connects The Companion to a cloud relay worker via outbound WebSocket.
// This allows a Companion instance running behind a firewall (NAT, no public IP)
// to receive external webhooks relayed through a cloud worker.
//
// Flow:
//   Companion --[outbound WS]--> Relay Worker <--[HTTPS webhooks]-- External platforms
//   Companion receives webhook_request messages, processes them locally,
//   and sends webhook_response messages back through the same WebSocket.

type WebhookHandler = (req: Request, opts?: { waitUntil?: (task: Promise<unknown>) => void }) => Promise<Response>;

/** Generic interface for webhook routing in the relay client */
export interface RelayWebhookRouter {
  /** Global webhook handlers keyed by platform name */
  webhooks: Record<string, WebhookHandler>;
  /** Get a webhook handler for a specific agent + platform combination */
  getWebhookHandler?: (agentId: string, platform: string) => WebhookHandler | null;
}

/** Inbound message from the relay worker containing a webhook to process */
interface WebhookRequestMessage {
  type: "webhook_request";
  requestId: string;
  platform: string;
  /** Optional agent ID for agent-scoped webhook routing */
  agentId?: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Outbound message sent back to the relay worker with the webhook response */
interface WebhookResponseMessage {
  type: "webhook_response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Any message that may arrive from the relay worker */
type RelayIncomingMessage = WebhookRequestMessage | { type: string; [key: string]: unknown };

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class RelayClient {
  private relayUrl: string;
  private relaySecret: string;
  private router: RelayWebhookRouter;

  private ws: WebSocket | null = null;
  private reconnectDelay = MIN_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  constructor(relayUrl: string, relaySecret: string, router: RelayWebhookRouter) {
    this.relayUrl = relayUrl;
    this.relaySecret = relaySecret;
    this.router = router;
  }

  /**
   * Open a WebSocket connection to the relay worker.
   * Automatically reconnects with exponential backoff on disconnection.
   */
  connect(): void {
    this.intentionalDisconnect = false;
    this.clearReconnectTimer();

    // Convert http(s) URL to ws(s) URL
    const wsUrl = this.buildWsUrl();
    const displayUrl = wsUrl.replace(/([?&])(secret)=[^&]*/gi, "$1$2=***");
    console.log(`[relay-client] Connecting to ${displayUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.log(`[relay-client] Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      console.log("[relay-client] Connected to relay worker");
      this.resetBackoff();
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      this.handleRawMessage(event.data);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      console.log(`[relay-client] Connection closed (code=${event.code}, reason=${event.reason || "none"})`);
      this.ws = null;

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener("error", (event: Event) => {
      // The error event does not carry much detail in browser-style WebSocket API;
      // the subsequent close event will trigger reconnection.
      console.log(`[relay-client] WebSocket error: ${String(event)}`);
    });
  }

  /**
   * Gracefully close the connection and stop reconnection attempts.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();

    if (this.ws) {
      console.log("[relay-client] Disconnecting from relay worker");
      try {
        this.ws.close(1000, "Client shutting down");
      } catch {
        // Ignore errors on close — socket may already be closed
      }
      this.ws = null;
    }
  }

  /**
   * Handle a parsed webhook_request message by forwarding it to the webhook router
   * and sending the response back to the relay worker.
   */
  async handleWebhookRequest(msg: WebhookRequestMessage): Promise<void> {
    const { requestId, platform, agentId, method, headers, body } = msg;

    // Route to agent-scoped handler if agentId is provided, otherwise use global handler
    const webhookHandler = agentId
      ? this.router.getWebhookHandler?.(agentId, platform) ?? null
      : this.router.webhooks[platform];

    if (!webhookHandler) {
      const target = agentId ? `agent "${agentId}" / platform "${platform}"` : `platform "${platform}"`;
      console.log(`[relay-client] No webhook handler for ${target}, returning 404`);
      this.sendWebhookResponse({
        type: "webhook_response",
        requestId,
        status: 404,
        headers: {},
        body: `No webhook handler for ${target}`,
      });
      return;
    }

    try {
      // Construct a Request object from the relayed data
      const hasBody = method !== "GET" && method !== "HEAD" && body;
      const request = new Request(`https://relay-proxy/${platform}`, {
        method,
        headers: new Headers(headers),
        body: hasBody ? body : undefined,
      });

      // Execute the webhook handler
      const response = await webhookHandler(request, {
        waitUntil: (task: Promise<unknown>) => {
          task.catch((err) => console.error("[relay-client] Background task error:", err));
        },
      });

      // Extract response details
      const responseBody = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      this.sendWebhookResponse({
        type: "webhook_response",
        requestId,
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      });
    } catch (err) {
      console.log(`[relay-client] Error processing webhook for platform "${platform}": ${err instanceof Error ? err.message : String(err)}`);
      this.sendWebhookResponse({
        type: "webhook_response",
        requestId,
        status: 500,
        headers: {},
        body: "Internal error",
      });
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Build the WebSocket URL from the relay HTTP URL.
   * Converts https:// to wss:// and http:// to ws://.
   */
  private buildWsUrl(): string {
    let url = this.relayUrl;

    if (url.startsWith("https://")) {
      url = "wss://" + url.slice("https://".length);
    } else if (url.startsWith("http://")) {
      url = "ws://" + url.slice("http://".length);
    }

    // Remove trailing slash if present before appending path
    url = url.replace(/\/+$/, "");

    // NOTE: The secret is passed as a query param for simplicity. This means
    // it may appear in relay-side HTTP access logs. For higher security, migrate
    // to an auth-frame approach (send secret as the first WebSocket message after
    // connection opens). Rotate the secret regularly if using this approach.
    return `${url}/ws/relay?secret=${encodeURIComponent(this.relaySecret)}`;
  }

  /**
   * Parse and route an incoming raw WebSocket message.
   */
  private handleRawMessage(data: unknown): void {
    let parsed: RelayIncomingMessage;

    try {
      const text = typeof data === "string" ? data : String(data);
      parsed = JSON.parse(text) as RelayIncomingMessage;
    } catch (err) {
      console.log(`[relay-client] Failed to parse message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!parsed || typeof parsed.type !== "string") {
      console.log("[relay-client] Received message without a valid type field, ignoring");
      return;
    }

    switch (parsed.type) {
      case "webhook_request":
        // Validate required fields before processing
        if (!this.isValidWebhookRequest(parsed)) {
          console.log("[relay-client] Received malformed webhook_request, ignoring");
          return;
        }
        // Fire-and-forget: errors are caught inside handleWebhookRequest
        void this.handleWebhookRequest(parsed as WebhookRequestMessage);
        break;

      default:
        console.log(`[relay-client] Received unknown message type: ${parsed.type}`);
        break;
    }
  }

  /**
   * Validate that a parsed message has all required webhook_request fields.
   */
  private isValidWebhookRequest(msg: RelayIncomingMessage): msg is WebhookRequestMessage {
    return (
      msg.type === "webhook_request" &&
      typeof (msg as WebhookRequestMessage).requestId === "string" &&
      typeof (msg as WebhookRequestMessage).platform === "string" &&
      typeof (msg as WebhookRequestMessage).method === "string" &&
      typeof (msg as WebhookRequestMessage).headers === "object" &&
      (msg as WebhookRequestMessage).headers !== null &&
      typeof (msg as WebhookRequestMessage).body === "string"
    );
  }

  /**
   * Send a webhook response message back through the WebSocket.
   */
  private sendWebhookResponse(response: WebhookResponseMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log(`[relay-client] Cannot send response for ${response.requestId}: WebSocket not open`);
      return;
    }

    try {
      this.ws.send(JSON.stringify(response));
    } catch (err) {
      console.log(`[relay-client] Failed to send response for ${response.requestId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;

    const delay = this.reconnectDelay;
    console.log(`[relay-client] Reconnecting in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Double the delay for next time, capped at max
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      this.connect();
    }, delay);
  }

  /**
   * Reset backoff delay to the minimum after a successful connection.
   */
  private resetBackoff(): void {
    this.reconnectDelay = MIN_RECONNECT_DELAY_MS;
  }

  /**
   * Clear any pending reconnection timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
