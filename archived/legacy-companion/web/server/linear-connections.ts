import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { getSettings } from "./settings-manager.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LinearConnection {
  id: string;
  name: string;
  apiKey: string;
  workspaceName: string;
  workspaceId: string;
  viewerName: string;
  viewerEmail: string;
  connected: boolean;
  autoTransition: boolean;
  autoTransitionStateId: string;
  autoTransitionStateName: string;
  archiveTransition: boolean;
  archiveTransitionStateId: string;
  archiveTransitionStateName: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(homedir(), ".companion", "linear-connections.json");

// ─── Store ───────────────────────────────────────────────────────────────────

let connections: LinearConnection[] = [];
let loaded = false;
let filePath = DEFAULT_PATH;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (Array.isArray(raw)) {
        connections = raw.filter(
          (c: unknown): c is LinearConnection =>
            typeof c === "object" &&
            c !== null &&
            typeof (c as LinearConnection).id === "string" &&
            typeof (c as LinearConnection).apiKey === "string",
        );
      } else {
        connections = [];
      }
    }
  } catch {
    connections = [];
  }
  loaded = true;

  // Auto-migrate from settings.json if no connections exist
  migrateFromSettings();
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(connections, null, 2), "utf-8");
}

// ─── Migration ───────────────────────────────────────────────────────────────

/**
 * One-time migration: if no connections exist but settings.linearApiKey is set,
 * create a "Default" connection from it.
 */
function migrateFromSettings(): void {
  if (connections.length > 0) return;

  const settings = getSettings();
  if (!settings.linearApiKey.trim()) return;

  const now = Date.now();
  connections.push({
    id: randomUUID(),
    name: "Default",
    apiKey: settings.linearApiKey.trim(),
    workspaceName: "",
    workspaceId: "",
    viewerName: "",
    viewerEmail: "",
    connected: false,
    autoTransition: settings.linearAutoTransition,
    autoTransitionStateId: settings.linearAutoTransitionStateId,
    autoTransitionStateName: settings.linearAutoTransitionStateName,
    archiveTransition: settings.linearArchiveTransition,
    archiveTransitionStateId: settings.linearArchiveTransitionStateId,
    archiveTransitionStateName: settings.linearArchiveTransitionStateName,
    createdAt: now,
    updatedAt: now,
  });
  persist();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function listConnections(): LinearConnection[] {
  ensureLoaded();
  return [...connections];
}

export function getConnection(id: string): LinearConnection | null {
  ensureLoaded();
  return connections.find((c) => c.id === id) ?? null;
}

/** Returns the first connection (used as default when no connectionId is specified). */
export function getDefaultConnection(): LinearConnection | null {
  ensureLoaded();
  return connections[0] ?? null;
}

export function createConnection(data: {
  name: string;
  apiKey: string;
}): LinearConnection {
  ensureLoaded();
  const now = Date.now();
  const conn: LinearConnection = {
    id: randomUUID(),
    name: data.name.trim(),
    apiKey: data.apiKey.trim(),
    workspaceName: "",
    workspaceId: "",
    viewerName: "",
    viewerEmail: "",
    connected: false,
    autoTransition: false,
    autoTransitionStateId: "",
    autoTransitionStateName: "",
    archiveTransition: false,
    archiveTransitionStateId: "",
    archiveTransitionStateName: "",
    createdAt: now,
    updatedAt: now,
  };
  connections.push(conn);
  persist();
  return conn;
}

export function updateConnection(
  id: string,
  patch: Partial<Omit<LinearConnection, "id" | "createdAt">>,
): LinearConnection | null {
  ensureLoaded();
  const conn = connections.find((c) => c.id === id);
  if (!conn) return null;

  if (patch.name !== undefined) conn.name = patch.name.trim();
  if (patch.apiKey !== undefined) conn.apiKey = patch.apiKey.trim();
  if (patch.workspaceName !== undefined) conn.workspaceName = patch.workspaceName;
  if (patch.workspaceId !== undefined) conn.workspaceId = patch.workspaceId;
  if (patch.viewerName !== undefined) conn.viewerName = patch.viewerName;
  if (patch.viewerEmail !== undefined) conn.viewerEmail = patch.viewerEmail;
  if (patch.connected !== undefined) conn.connected = patch.connected;
  if (patch.autoTransition !== undefined) conn.autoTransition = patch.autoTransition;
  if (patch.autoTransitionStateId !== undefined) conn.autoTransitionStateId = patch.autoTransitionStateId;
  if (patch.autoTransitionStateName !== undefined) conn.autoTransitionStateName = patch.autoTransitionStateName;
  if (patch.archiveTransition !== undefined) conn.archiveTransition = patch.archiveTransition;
  if (patch.archiveTransitionStateId !== undefined) conn.archiveTransitionStateId = patch.archiveTransitionStateId;
  if (patch.archiveTransitionStateName !== undefined) conn.archiveTransitionStateName = patch.archiveTransitionStateName;
  conn.updatedAt = Date.now();

  persist();
  return conn;
}

export function deleteConnection(id: string): boolean {
  ensureLoaded();
  const idx = connections.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  connections.splice(idx, 1);
  persist();
  return true;
}

/**
 * Resolve a Linear API key from a connectionId.
 * - If connectionId is provided, look up that specific connection.
 * - Otherwise, fall back to the first connection.
 * - As a last resort, fall back to the legacy settings.linearApiKey.
 * Returns null if no API key can be found.
 */
export function resolveApiKey(
  connectionId?: string,
): { apiKey: string; connectionId: string } | null {
  ensureLoaded();

  if (connectionId) {
    const conn = connections.find((c) => c.id === connectionId);
    if (conn?.apiKey.trim()) {
      return { apiKey: conn.apiKey.trim(), connectionId: conn.id };
    }
    return null;
  }

  // Default to first connection
  const defaultConn = connections[0];
  if (defaultConn?.apiKey.trim()) {
    return { apiKey: defaultConn.apiKey.trim(), connectionId: defaultConn.id };
  }

  // Legacy fallback: settings.linearApiKey
  const settings = getSettings();
  if (settings.linearApiKey.trim()) {
    return { apiKey: settings.linearApiKey.trim(), connectionId: "legacy" };
  }

  return null;
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  connections = [];
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
}
