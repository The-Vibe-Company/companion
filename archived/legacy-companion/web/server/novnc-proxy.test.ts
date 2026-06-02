/**
 * Tests for NoVncProxy — WebSocket relay between browser and container's websockify.
 *
 * Validates:
 * - handleOpen: no container → closes with 1011
 * - handleOpen: no port mapping → closes with 1011
 * - handleOpen: successful upstream connection + message relay (both directions)
 * - handleMessage: relays binary and text frames to upstream
 * - handleMessage: no-op when pair not found or upstream not open
 * - handleClose: closes upstream and cleans up pair
 * - Upstream close propagates to browser socket
 * - Upstream error propagates to browser socket
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock container-manager ──────────────────────────────────────────────────
const mockGetContainer = vi.hoisted(() => vi.fn());

vi.mock("./container-manager.js", () => ({
  containerManager: {
    getContainer: mockGetContainer,
  },
}));

// ── Mock WebSocket ──────────────────────────────────────────────────────────
// The NoVncProxy creates native WebSocket instances to connect to the container.
// We intercept these with a fake implementation that captures event listeners.

interface FakeWebSocketInstance {
  binaryType: string;
  readyState: number;
  listeners: Record<string, Array<(ev: unknown) => void>>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, cb: (ev: unknown) => void) => void;
}

let lastCreatedUpstream: FakeWebSocketInstance | null = null;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  binaryType = "blob";
  readyState = 0; // CONNECTING
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  send = vi.fn();
  close = vi.fn();

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    // Store for test access
    lastCreatedUpstream = this as unknown as FakeWebSocketInstance;
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }
}

// Patch global WebSocket so NoVncProxy uses our fake
vi.stubGlobal("WebSocket", FakeWebSocket);

import { NoVncProxy } from "./novnc-proxy.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a mock ServerWebSocket that behaves like Bun's ServerWebSocket. */
function makeBrowserWs() {
  return {
    data: { kind: "novnc" as const, sessionId: "s1" },
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as import("bun").ServerWebSocket<import("./ws-bridge-types.js").SocketData>;
}

function fireUpstreamEvent(upstream: FakeWebSocketInstance, type: string, payload?: unknown) {
  for (const cb of upstream.listeners[type] ?? []) {
    cb(payload);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("NoVncProxy", () => {
  let proxy: NoVncProxy;

  beforeEach(() => {
    vi.clearAllMocks();
    lastCreatedUpstream = null;
    proxy = new NoVncProxy();
  });

  // ── handleOpen ──────────────────────────────────────────────────────────

  it("closes browser socket with 1011 when container not found", () => {
    mockGetContainer.mockReturnValue(undefined);
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");

    expect(ws.close).toHaveBeenCalledWith(1011, "Container not found");
    // No upstream should have been created
    expect(lastCreatedUpstream).toBeNull();
  });

  it("closes browser socket with 1011 when noVNC port not mapped", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 3000, hostPort: 49100 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");

    expect(ws.close).toHaveBeenCalledWith(1011, "noVNC port not mapped");
    expect(lastCreatedUpstream).toBeNull();
  });

  it("connects to upstream websockify when container and port mapping exist", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");

    expect(lastCreatedUpstream).not.toBeNull();
    expect(lastCreatedUpstream!.binaryType).toBe("arraybuffer");
    // Upstream URL should use the host port from the mapping
    expect((lastCreatedUpstream as unknown as FakeWebSocket).url).toBe(
      "ws://127.0.0.1:49200",
    );
  });

  it("relays ArrayBuffer messages from upstream to browser socket", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;

    // Simulate upstream sending an ArrayBuffer (binary VNC frame)
    const buf = new ArrayBuffer(4);
    fireUpstreamEvent(upstream, "message", { data: buf });

    expect(ws.send).toHaveBeenCalledTimes(1);
    // Should send as Uint8Array wrapping the ArrayBuffer
    const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent).toBeInstanceOf(Uint8Array);
  });

  it("relays text messages from upstream to browser socket", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;

    // Simulate upstream sending a text message
    fireUpstreamEvent(upstream, "message", { data: "hello" });

    expect(ws.send).toHaveBeenCalledWith("hello");
  });

  it("cleans up and closes browser socket when upstream closes", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;

    fireUpstreamEvent(upstream, "close");

    expect(ws.close).toHaveBeenCalled();
    // Pair should be removed — subsequent handleMessage should be no-op
    proxy.handleMessage(ws, "test");
  });

  it("cleans up and closes browser socket on upstream error", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;

    fireUpstreamEvent(upstream, "error", new Error("connection refused"));

    expect(ws.close).toHaveBeenCalledWith(1011, "Upstream connection failed");
  });

  // ── handleMessage ───────────────────────────────────────────────────────

  it("relays text messages from browser to upstream", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;
    upstream.readyState = WebSocket.OPEN;

    proxy.handleMessage(ws, "browser-text");

    expect(upstream.send).toHaveBeenCalledWith("browser-text");
  });

  it("relays Buffer messages from browser to upstream", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;
    upstream.readyState = WebSocket.OPEN;

    const buf = Buffer.from([0x01, 0x02, 0x03]);
    proxy.handleMessage(ws, buf);

    // After dead-code removal, Buffer input is always converted to Uint8Array
    expect(upstream.send).toHaveBeenCalledWith(new Uint8Array(buf));
  });

  it("is a no-op when pair not found", () => {
    const ws = makeBrowserWs();
    // No handleOpen called — no pair exists
    proxy.handleMessage(ws, "test");
    // Should not throw
  });

  it("is a no-op when upstream is not open", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;
    upstream.readyState = 0; // CONNECTING, not OPEN

    proxy.handleMessage(ws, "test");

    expect(upstream.send).not.toHaveBeenCalled();
  });

  // ── handleClose ─────────────────────────────────────────────────────────

  it("closes upstream and cleans up when browser socket closes", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;

    proxy.handleClose(ws);

    expect(upstream.close).toHaveBeenCalled();
    // Pair should be removed — calling again should be no-op
    proxy.handleClose(ws);
  });

  it("is a no-op when pair not found on close", () => {
    const ws = makeBrowserWs();
    // No handleOpen called
    proxy.handleClose(ws);
    // Should not throw
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("handles browser ws.send throwing when upstream relays message", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();
    (ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("socket closed");
    });

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;

    // Should not throw — the error is caught internally
    fireUpstreamEvent(upstream, "message", { data: "test" });
  });

  it("handles upstream.send throwing when browser relays message", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;
    upstream.readyState = WebSocket.OPEN;
    upstream.send.mockImplementation(() => {
      throw new Error("socket closed");
    });

    // Should not throw — the error is caught internally
    proxy.handleMessage(ws, "test");
  });

  it("handles upstream.close throwing on browser close", () => {
    mockGetContainer.mockReturnValue({
      portMappings: [{ containerPort: 6080, hostPort: 49200 }],
    });
    const ws = makeBrowserWs();

    proxy.handleOpen(ws, "s1");
    const upstream = lastCreatedUpstream!;
    upstream.close.mockImplementation(() => {
      throw new Error("already closed");
    });

    // Should not throw — the error is caught internally
    proxy.handleClose(ws);
  });
});
