import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompanionSandbox {
  name: string;
  slug: string;
  /** Shell script to run inside the container before the CLI session starts */
  initScript?: string;
  createdAt: number;
  updatedAt: number;
}

/** Fields that can be updated via the update API */
export interface SandboxUpdateFields {
  name?: string;
  initScript?: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const SANDBOXES_DIR = join(COMPANION_DIR, "sandboxes");

function ensureDir(): void {
  mkdirSync(SANDBOXES_DIR, { recursive: true });
}

/** Validate that a slug contains only safe characters (prevents path traversal) */
function validateSlug(slug: string): void {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Invalid slug: must contain only lowercase alphanumeric characters and hyphens");
  }
}

function filePath(slug: string): string {
  validateSlug(slug);
  return join(SANDBOXES_DIR, `${slug}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listSandboxes(): CompanionSandbox[] {
  ensureDir();
  try {
    const files = readdirSync(SANDBOXES_DIR).filter((f) => f.endsWith(".json"));
    const sandboxes: CompanionSandbox[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(SANDBOXES_DIR, file), "utf-8");
        sandboxes.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    sandboxes.sort((a, b) => a.name.localeCompare(b.name));
    return sandboxes;
  } catch {
    return [];
  }
}

export function getSandbox(slug: string): CompanionSandbox | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(slug), "utf-8");
    return JSON.parse(raw) as CompanionSandbox;
  } catch {
    return null;
  }
}

export function createSandbox(
  name: string,
  opts?: { initScript?: string },
): CompanionSandbox {
  if (!name || !name.trim()) throw new Error("Sandbox name is required");
  const slug = slugify(name.trim());
  if (!slug) throw new Error("Sandbox name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(slug))) {
    throw new Error(`A sandbox with a similar name already exists ("${slug}")`);
  }

  const now = Date.now();
  const sandbox: CompanionSandbox = {
    name: name.trim(),
    slug,
    createdAt: now,
    updatedAt: now,
  };

  // Apply optional fields if provided
  if (opts) {
    if (opts.initScript !== undefined) sandbox.initScript = opts.initScript;
  }

  writeFileSync(filePath(slug), JSON.stringify(sandbox, null, 2), "utf-8");
  return sandbox;
}

export function updateSandbox(
  slug: string,
  updates: SandboxUpdateFields,
): CompanionSandbox | null {
  ensureDir();
  const existing = getSandbox(slug);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newSlug = slugify(newName);
  if (!newSlug) throw new Error("Sandbox name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different sandbox
  if (newSlug !== slug && existsSync(filePath(newSlug))) {
    throw new Error(`A sandbox with a similar name already exists ("${newSlug}")`);
  }

  const sandbox: CompanionSandbox = {
    ...existing,
    name: newName,
    slug: newSlug,
    updatedAt: Date.now(),
  };

  // Apply field updates (only override if explicitly provided)
  if (updates.initScript !== undefined) sandbox.initScript = updates.initScript;

  // If slug changed, delete old file
  if (newSlug !== slug) {
    try { unlinkSync(filePath(slug)); } catch { /* ok */ }
  }

  writeFileSync(filePath(newSlug), JSON.stringify(sandbox, null, 2), "utf-8");
  return sandbox;
}

export function deleteSandbox(slug: string): boolean {
  ensureDir();
  if (!existsSync(filePath(slug))) return false;
  try {
    unlinkSync(filePath(slug));
    return true;
  } catch {
    return false;
  }
}
