import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { CronJob, CronJobCreateInput } from "./cron-types.js";
import { COMPANION_HOME } from "./paths.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const CRON_DIR = join(COMPANION_HOME, "cron");

function ensureDir(): void {
  mkdirSync(CRON_DIR, { recursive: true });
}

function filePath(id: string): string {
  return join(CRON_DIR, `${id}.json`);
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

export function listJobs(): CronJob[] {
  ensureDir();
  try {
    const files = readdirSync(CRON_DIR).filter((f) => f.endsWith(".json"));
    const jobs: CronJob[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(CRON_DIR, file), "utf-8");
        jobs.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    jobs.sort((a, b) => a.name.localeCompare(b.name));
    return jobs;
  } catch {
    return [];
  }
}

export function getJob(id: string): CronJob | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(id), "utf-8");
    return JSON.parse(raw) as CronJob;
  } catch {
    return null;
  }
}

export function createJob(data: CronJobCreateInput): CronJob {
  if (!data.name || !data.name.trim()) throw new Error("Job name is required");
  if (!data.prompt || !data.prompt.trim()) throw new Error("Job prompt is required");
  if (!data.schedule || !data.schedule.trim()) throw new Error("Job schedule is required");
  if (!data.cwd || !data.cwd.trim()) throw new Error("Job working directory is required");

  const id = slugify(data.name.trim());
  if (!id) throw new Error("Job name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(id))) {
    throw new Error(`A job with a similar name already exists ("${id}")`);
  }

  const now = Date.now();
  const job: CronJob = {
    ...data,
    id,
    name: data.name.trim(),
    prompt: data.prompt.trim(),
    schedule: data.schedule.trim(),
    cwd: data.cwd.trim(),
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    totalRuns: 0,
  };
  writeFileSync(filePath(id), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

export function updateJob(
  id: string,
  updates: Partial<CronJob>,
): CronJob | null {
  ensureDir();
  const existing = getJob(id);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newId = slugify(newName);
  if (!newId) throw new Error("Job name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different job
  if (newId !== id && existsSync(filePath(newId))) {
    throw new Error(`A job with a similar name already exists ("${newId}")`);
  }

  const job: CronJob = {
    ...existing,
    ...updates,
    id: newId,
    name: newName,
    updatedAt: Date.now(),
    // Preserve immutable fields
    createdAt: existing.createdAt,
  };

  // If id changed, delete old file
  if (newId !== id) {
    try {
      unlinkSync(filePath(id));
    } catch {
      /* ok */
    }
  }

  writeFileSync(filePath(newId), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

export function deleteJob(id: string): boolean {
  ensureDir();
  if (!existsSync(filePath(id))) return false;
  try {
    unlinkSync(filePath(id));
    return true;
  } catch {
    return false;
  }
}
