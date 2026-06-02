#!/usr/bin/env node
"use strict";

// Bridges newline-delimited JSON on stdin/stdout to WebSocket text frames for
// Codex app-server. Runs in real Node (not Bun) so the `ws` package handles the
// Codex Rust server handshake correctly with perMessageDeflate disabled.

const readline = require("node:readline");
const WebSocket = require("ws");

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] || "30000");
const pongTimeoutArg = process.argv[4];

if (!url) {
  process.stderr.write("[codex-ws-proxy] Missing URL argument\n");
  process.exit(2);
}

let ws = null;
let opened = false;
let closed = false;
let exiting = false;
let queue = [];
let connectAttempt = 0;
const startedAt = Date.now();

// Reconnection state — after a successful initial connection, transient
// WebSocket drops are retried with exponential backoff before giving up.
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5000;
let reconnecting = false;
let reconnectAttempt = 0;

// Heartbeat — detect zombie WebSocket connections where the TCP socket is open
// but the remote Codex process has stopped responding.
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = pongTimeoutArg ? Number(pongTimeoutArg) : 30000;
let pingTimer = null;
let pongTimer = null;

function log(msg) {
  process.stderr.write(`[codex-ws-proxy] ${msg}\n`);
}

function startHeartbeat() {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    ws.ping();
    pongTimer = setTimeout(() => {
      log("Pong timeout — connection appears dead");
      try { ws.terminate(); } catch {}
      // terminate() fires the close event which triggers scheduleReconnect
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

function decodeMessageData(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((x) => Buffer.from(x))).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN || queue.length === 0) return;
  for (const line of queue) {
    ws.send(line);
  }
  queue = [];
}

function failAndExit(message, code = 1) {
  if (exiting) return;
  exiting = true;
  stopHeartbeat();
  log(message);
  try { if (ws) ws.close(); } catch {}
  process.exit(code);
}

/**
 * Attempt to reconnect after a post-open WebSocket drop.
 * Uses exponential backoff up to MAX_RECONNECT_ATTEMPTS before giving up.
 */
function scheduleReconnect(reason) {
  if (closed || exiting) return;
  stopHeartbeat();
  reconnectAttempt++;
  if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    failAndExit(`WebSocket reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts (last: ${reason})`);
    return;
  }

  reconnecting = true;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1), RECONNECT_MAX_MS);
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}) — ${reason}`);
  setTimeout(connect, delay);
}

function connect() {
  if (closed || exiting) return;

  // During initial connection (before first successful open), enforce timeout.
  if (!opened) {
    connectAttempt += 1;
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      failAndExit(`Failed to connect within ${timeoutMs}ms`);
      return;
    }
  }

  ws = new WebSocket(url, { perMessageDeflate: false });

  ws.once("open", () => {
    if (!opened) {
      opened = true;
    }
    const wasReconnect = reconnecting;
    if (reconnecting) {
      log(`Reconnected successfully (attempt ${reconnectAttempt})`);
      reconnecting = false;
      reconnectAttempt = 0;
    }
    startHeartbeat();
    flushQueue();
    // Notify the adapter AFTER flushing any buffered messages so stale Codex
    // responses from the pre-drop session are delivered before the adapter
    // rejects all pending calls and cleans up.
    if (wasReconnect) {
      const reconnectNotification = JSON.stringify({
        method: "companion/wsReconnected",
        params: {},
      });
      process.stdout.write(reconnectNotification + "\n");
    }
  });

  ws.on("message", (data) => {
    const raw = decodeMessageData(data);
    // stdout is protocol channel: ONLY write payload lines
    process.stdout.write(raw + "\n");
  });

  ws.on("pong", () => {
    // Heartbeat response received — connection is alive
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  });

  ws.once("close", (code, reason) => {
    stopHeartbeat();
    if (closed || exiting) return;
    const why = reason ? ` reason=${reason}` : "";
    // If connection closes before we ever opened, keep retrying until timeout.
    if (!opened) {
      setTimeout(connect, Math.min(100 * connectAttempt, 500));
      return;
    }
    // Post-open close — attempt reconnection with backoff
    scheduleReconnect(`WebSocket closed (code=${code}${why})`);
  });

  ws.once("error", (err) => {
    if (closed || exiting) return;
    // Retry during startup; after a successful connection, use reconnect logic.
    if (!opened) {
      setTimeout(connect, Math.min(100 * connectAttempt, 500));
      return;
    }
    // Post-open error — attempt reconnection with backoff
    scheduleReconnect(`WebSocket error: ${err && err.message ? err.message : String(err)}`);
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (closed || exiting) return;
  if (!line) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    queue.push(line);
    return;
  }
  ws.send(line);
});

rl.on("close", () => {
  closed = true;
  stopHeartbeat();
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  } catch {}
  process.exit(0);
});

process.on("SIGINT", () => {
  closed = true;
  stopHeartbeat();
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});

process.on("SIGTERM", () => {
  closed = true;
  stopHeartbeat();
  try { if (ws) ws.close(); } catch {}
  process.exit(0);
});

connect();
