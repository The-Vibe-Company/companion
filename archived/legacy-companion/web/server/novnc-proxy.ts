import type { ServerWebSocket } from "bun";
import type { SocketData } from "./ws-bridge-types.js";
import { containerManager } from "./container-manager.js";

const NOVNC_CONTAINER_PORT = 6080;

interface ProxyPair {
  browserWs: ServerWebSocket<SocketData>;
  upstreamWs: WebSocket;
}

/**
 * Proxies noVNC WebSocket traffic between the user's browser and the
 * container's websockify server. This allows the noVNC client to connect
 * through the companion's single port instead of requiring direct access
 * to the container's mapped port.
 */
export class NoVncProxy {
  private pairs = new Map<ServerWebSocket<SocketData>, ProxyPair>();

  handleOpen(ws: ServerWebSocket<SocketData>, sessionId: string): void {
    const container = containerManager.getContainer(sessionId);
    if (!container) {
      console.warn(`[novnc-proxy] No container found for session ${sessionId}`);
      ws.close(1011, "Container not found");
      return;
    }

    const portMapping = container.portMappings.find(
      (p) => p.containerPort === NOVNC_CONTAINER_PORT,
    );
    if (!portMapping) {
      console.warn(`[novnc-proxy] No noVNC port mapping for session ${sessionId}`);
      ws.close(1011, "noVNC port not mapped");
      return;
    }

    // Connect to the container's websockify server
    const upstreamUrl = `ws://127.0.0.1:${portMapping.hostPort}`;
    const upstream = new WebSocket(upstreamUrl, ["binary"]);
    upstream.binaryType = "arraybuffer";

    const pair: ProxyPair = { browserWs: ws, upstreamWs: upstream };
    this.pairs.set(ws, pair);

    upstream.addEventListener("open", () => {
      console.log(`[novnc-proxy] Upstream connected for session ${sessionId}`);
    });

    upstream.addEventListener("message", (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          ws.send(new Uint8Array(event.data));
        } else {
          ws.send(event.data);
        }
      } catch {
        // Browser socket may have closed
      }
    });

    upstream.addEventListener("close", () => {
      this.pairs.delete(ws);
      try { ws.close(); } catch { /* already closed */ }
    });

    upstream.addEventListener("error", (err) => {
      console.error(`[novnc-proxy] Upstream error for session ${sessionId}:`, err);
      this.pairs.delete(ws);
      try { ws.close(1011, "Upstream connection failed"); } catch { /* already closed */ }
    });
  }

  handleMessage(ws: ServerWebSocket<SocketData>, msg: string | Buffer): void {
    const pair = this.pairs.get(ws);
    if (!pair) return;

    const { upstreamWs } = pair;
    if (upstreamWs.readyState !== WebSocket.OPEN) return;

    try {
      upstreamWs.send(msg instanceof Buffer ? new Uint8Array(msg) : msg);
    } catch {
      // Upstream may have closed
    }
  }

  handleClose(ws: ServerWebSocket<SocketData>): void {
    const pair = this.pairs.get(ws);
    if (!pair) return;

    this.pairs.delete(ws);
    try {
      pair.upstreamWs.close();
    } catch {
      // Already closed
    }
  }
}
