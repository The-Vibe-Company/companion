// ─── Linear OAuth Staging Slots ──────────────────────────────────────────────
// Temporary, file-backed credential storage for the Linear agent wizard.
// Each wizard invocation gets a unique staging slot so multiple wizards
// (or multiple agents) never collide. Slots are automatically cleaned up
// after 30 minutes.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { COMPANION_HOME } from "./paths.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StagingSlot {
  id: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  accessToken: string;
  refreshToken: string;
  createdAt: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STAGING_DIR = join(COMPANION_HOME, "staging");
const SLOT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function ensureDir(): void {
  mkdirSync(STAGING_DIR, { recursive: true });
}

function slotPath(id: string): string {
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new Error(`Invalid staging slot ID: ${id}`);
  }
  return join(STAGING_DIR, `${id}.json`);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Create a new staging slot with the given credentials. Returns the slot ID. */
export function createSlot(creds: {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}): string {
  ensureDir();
  pruneExpired();

  const id = randomBytes(16).toString("hex");
  const slot: StagingSlot = {
    id,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    webhookSecret: creds.webhookSecret,
    accessToken: "",
    refreshToken: "",
    createdAt: Date.now(),
  };

  writeFileSync(slotPath(id), JSON.stringify(slot, null, 2), { mode: 0o600 });
  return id;
}

/** Retrieve a staging slot by ID. Returns null if not found or expired. */
export function getSlot(id: string): StagingSlot | null {
  ensureDir();
  try {
    const raw = readFileSync(slotPath(id), "utf-8");
    const slot = JSON.parse(raw) as StagingSlot;
    if (Date.now() - slot.createdAt > SLOT_TTL_MS) {
      try { unlinkSync(slotPath(id)); } catch { /* ok */ }
      return null;
    }
    return slot;
  } catch {
    return null;
  }
}

/** Update a staging slot's OAuth tokens (after the OAuth callback). */
export function updateSlotTokens(
  id: string,
  tokens: { accessToken: string; refreshToken: string },
): boolean {
  const slot = getSlot(id);
  if (!slot) return false;

  slot.accessToken = tokens.accessToken;
  slot.refreshToken = tokens.refreshToken;

  writeFileSync(slotPath(id), JSON.stringify(slot, null, 2), { mode: 0o600 });
  return true;
}

/** Retrieve and delete a staging slot (one-time consume). */
export function consumeSlot(id: string): StagingSlot | null {
  const slot = getSlot(id);
  if (!slot) return null;
  try { unlinkSync(slotPath(id)); } catch { /* ok */ }
  return slot;
}

/** Delete a staging slot. */
export function deleteSlot(id: string): boolean {
  try {
    unlinkSync(slotPath(id));
    return true;
  } catch {
    return false;
  }
}

/** Remove all expired staging slots. Called on create and on server start. */
export function pruneExpired(): void {
  ensureDir();
  try {
    const now = Date.now();
    for (const file of readdirSync(STAGING_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(STAGING_DIR, file), "utf-8");
        const slot = JSON.parse(raw) as StagingSlot;
        if (now - slot.createdAt > SLOT_TTL_MS) {
          unlinkSync(join(STAGING_DIR, file));
        }
      } catch {
        // Remove corrupt files
        try { unlinkSync(join(STAGING_DIR, file)); } catch { /* ok */ }
      }
    }
  } catch {
    // Directory doesn't exist yet, nothing to prune
  }
}
