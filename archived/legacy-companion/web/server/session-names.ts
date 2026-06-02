import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { COMPANION_HOME } from "./paths.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(COMPANION_HOME, "session-names.json");

// ─── Store ──────────────────────────────────────────────────────────────────

let names: Record<string, string> = {};
let loaded = false;
let filePath = DEFAULT_PATH;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      names = JSON.parse(raw) as Record<string, string>;
    }
  } catch {
    names = {};
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(names, null, 2), "utf-8");
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function getName(sessionId: string): string | undefined {
  ensureLoaded();
  return names[sessionId];
}

export function setName(sessionId: string, name: string): void {
  ensureLoaded();
  names[sessionId] = name;
  persist();
}

export function getAllNames(): Record<string, string> {
  ensureLoaded();
  return { ...names };
}

export function removeName(sessionId: string): void {
  ensureLoaded();
  delete names[sessionId];
  persist();
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  names = {};
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
}
