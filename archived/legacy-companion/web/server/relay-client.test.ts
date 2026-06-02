import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { RelayClient } from "./relay-client.js";

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

/** Minimal mock WebSocket with event listener support for testing. */
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  private listeners = new Map<string, Set<Function>>();

  sent: string[] = [];

  constructor(public url: string) {
    // Auto-fire "open" on next tick so tests can add listeners first
    setTimeout(() => this.fireEvent("open", {}), 0);
  }

  addEventListener(event: string, fn: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  removeEventListener(event: string, fn: Function) {
    this.listeners.get(event)?.delete(fn);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.fireEvent("close", { code: _code || 1000, reason: _reason || "" });
  }

  /** Helper: simulate receiving a message from the relay. */
  simulateMessage(data: string) {
    this.fireEvent("message", { data });
  }

  /** Helper: simulate the connection closing. */
  simulateClose(code = 1006, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.fireEvent("close", { code, reason });
  }

  private fireEvent(event: string, detail: Record<string, unknown>) {
    this.listeners.get(event)?.forEach((fn) => fn(detail));
  }
}

// Replace global WebSocket with mock
let capturedWs: MockWebSocket | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  capturedWs = null;

  // Capture the WebSocket constructor call so we can interact with the instance
  vi.stubGlobal("WebSocket", class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      capturedWs = this;
    }
    static OPEN = 1;
    static CLOSED = 3;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockRouter() {
  return {
    webhooks: {} as Record<string, (req: Request, opts?: { waitUntil?: (task: Promise<unknown>) => void }) => Promise<Response>>,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("RelayClient", () => {
  describe("connect()", () => {
    it("builds the correct WebSocket URL from an HTTPS relay URL", () => {
      const router = createMockRouter();
      const client = new RelayClient(
        "https://relay.example.com",
        "my-secret",
        router as any,
      );

      client.connect();

      // The WebSocket should be constructed with wss:// and the secret in the query param
      expect(capturedWs).not.toBeNull();
      expect(capturedWs!.url).toBe("wss://relay.example.com/ws/relay?secret=my-secret");
    });

    it("converts HTTP relay URL to WS (not WSS)", () => {
      const router = createMockRouter();
      const client = new RelayClient(
        "http://localhost:8787",
        "dev-secret",
        router as any,
      );

      client.connect();

      expect(capturedWs!.url).toBe("ws://localhost:8787/ws/relay?secret=dev-secret");
    });

    it("redacts the secret from log output", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const router = createMockRouter();
      const client = new RelayClient(
        "https://relay.example.com",
        "super-secret-value",
        router as any,
      );

      client.connect();

      // The log message should contain the URL but with the secret redacted
      const logCall = logSpy.mock.calls.find((args) =>
        typeof args[0] === "string" && args[0].includes("[relay-client] Connecting to"),
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).not.toContain("super-secret-value");
      expect(logCall![0]).toContain("secret=***");

      logSpy.mockRestore();
    });

    it("strips trailing slashes from the relay URL", () => {
      const router = createMockRouter();
      const client = new RelayClient(
        "https://relay.example.com///",
        "s",
        router as any,
      );

      client.connect();

      expect(capturedWs!.url).toBe("wss://relay.example.com/ws/relay?secret=s");
    });
  });

  describe("disconnect()", () => {
    it("closes the WebSocket and prevents reconnection", async () => {
      const router = createMockRouter();
      const client = new RelayClient("https://relay.example.com", "s", router as any);

      client.connect();
      await vi.advanceTimersByTimeAsync(0); // let "open" event fire

      expect(capturedWs!.readyState).toBe(MockWebSocket.OPEN);

      client.disconnect();

      // After disconnect, the WebSocket should be closed
      expect(capturedWs!.readyState).toBe(MockWebSocket.CLOSED);
    });
  });

  describe("handleWebhookRequest()", () => {
    it("forwards a webhook request to the handler and sends back the response", async () => {
      const router = createMockRouter();
      router.webhooks = {
        github: vi.fn(async () => new Response("OK", { status: 200 })),
      };

      const client = new RelayClient("https://relay.example.com", "s", router as any);
      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      // handleWebhookRequest is private, but we can trigger it via a message
      capturedWs!.simulateMessage(JSON.stringify({
        type: "webhook_request",
        requestId: "req-1",
        platform: "github",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"event":"test"}',
      }));

      // Wait for async processing
      await vi.advanceTimersByTimeAsync(10);

      // The webhook handler should have been called
      expect(router.webhooks.github).toHaveBeenCalledTimes(1);

      // The relay client should have sent a webhook_response back
      expect(capturedWs!.sent).toHaveLength(1);
      const response = JSON.parse(capturedWs!.sent[0]);
      expect(response.type).toBe("webhook_response");
      expect(response.requestId).toBe("req-1");
      expect(response.status).toBe(200);
    });

    it("returns 404 when no handler exists for the requested platform", async () => {
      const router = createMockRouter();
      router.webhooks = {}; // No handlers

      const client = new RelayClient("https://relay.example.com", "s", router as any);
      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      capturedWs!.simulateMessage(JSON.stringify({
        type: "webhook_request",
        requestId: "req-2",
        platform: "unknown-platform",
        method: "POST",
        headers: {},
        body: "",
      }));

      await vi.advanceTimersByTimeAsync(10);

      expect(capturedWs!.sent).toHaveLength(1);
      const response = JSON.parse(capturedWs!.sent[0]);
      expect(response.type).toBe("webhook_response");
      expect(response.requestId).toBe("req-2");
      expect(response.status).toBe(404);
    });

    it("returns 500 when the webhook handler throws", async () => {
      const router = createMockRouter();
      router.webhooks = {
        github: vi.fn(async () => { throw new Error("boom"); }),
      };

      const client = new RelayClient("https://relay.example.com", "s", router as any);
      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      capturedWs!.simulateMessage(JSON.stringify({
        type: "webhook_request",
        requestId: "req-3",
        platform: "github",
        method: "POST",
        headers: {},
        body: "test",
      }));

      await vi.advanceTimersByTimeAsync(10);

      expect(capturedWs!.sent).toHaveLength(1);
      const response = JSON.parse(capturedWs!.sent[0]);
      expect(response.status).toBe(500);
    });
  });

  describe("message handling", () => {
    it("ignores unknown message types", async () => {
      const router = createMockRouter();
      const client = new RelayClient("https://relay.example.com", "s", router as any);
      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Should not throw or send any response
      capturedWs!.simulateMessage(JSON.stringify({ type: "unknown_type" }));
      await vi.advanceTimersByTimeAsync(10);

      expect(capturedWs!.sent).toHaveLength(0);
    });

    it("ignores malformed JSON messages", async () => {
      const router = createMockRouter();
      const client = new RelayClient("https://relay.example.com", "s", router as any);
      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Should not throw
      capturedWs!.simulateMessage("not valid json {{{");
      await vi.advanceTimersByTimeAsync(10);

      expect(capturedWs!.sent).toHaveLength(0);
    });

    it("ignores malformed webhook_request (missing required fields)", async () => {
      const router = createMockRouter();
      const client = new RelayClient("https://relay.example.com", "s", router as any);
      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      // Missing platform, method, headers, body
      capturedWs!.simulateMessage(JSON.stringify({ type: "webhook_request", requestId: "r" }));
      await vi.advanceTimersByTimeAsync(10);

      expect(capturedWs!.sent).toHaveLength(0);
    });
  });

  describe("reconnection", () => {
    it("schedules a reconnection when the WebSocket closes unexpectedly", async () => {
      const router = createMockRouter();
      const client = new RelayClient("https://relay.example.com", "s", router as any);

      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      const firstWs = capturedWs!;
      firstWs.simulateClose(1006, "abnormal");

      // After 1s (initial backoff), a new connection attempt should be made
      await vi.advanceTimersByTimeAsync(1000);

      // A new WebSocket should have been created
      expect(capturedWs).not.toBe(firstWs);
    });

    it("does not reconnect after an intentional disconnect", async () => {
      const router = createMockRouter();
      const client = new RelayClient("https://relay.example.com", "s", router as any);

      client.connect();
      await vi.advanceTimersByTimeAsync(0);

      const firstWs = capturedWs!;
      client.disconnect();

      // Advance well past the reconnect delay
      await vi.advanceTimersByTimeAsync(60000);

      // Should still be the same (closed) WebSocket — no new connection created
      // (capturedWs may be a new reference from disconnect's close(), but no connect() should follow)
      // The key test: no new open event or connection attempt
      expect(capturedWs!.readyState).toBe(MockWebSocket.CLOSED);
    });
  });
});
