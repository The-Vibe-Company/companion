import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMPANION_HOME } from "./paths.js";

export type PromptScope = "global" | "project";

export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  scope: PromptScope;
  projectPath?: string;
  projectPaths?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PromptUpdateFields {
  name?: string;
  content?: string;
  scope?: PromptScope;
  projectPaths?: string[];
}

const PROMPTS_FILE = join(COMPANION_HOME, "prompts.json");

function ensureDir(): void {
  mkdirSync(COMPANION_HOME, { recursive: true });
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "");
}

function loadPrompts(): SavedPrompt[] {
  ensureDir();
  if (!existsSync(PROMPTS_FILE)) return [];
  try {
    const raw = readFileSync(PROMPTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is SavedPrompt => {
      if (!p || typeof p !== "object") return false;
      const candidate = p as Partial<SavedPrompt>;
      return (
        typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && typeof candidate.content === "string"
        && (candidate.scope === "global" || candidate.scope === "project")
      );
    });
  } catch {
    return [];
  }
}

function savePrompts(prompts: SavedPrompt[]): void {
  ensureDir();
  writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2), "utf-8");
}

function sortPrompts(prompts: SavedPrompt[]): SavedPrompt[] {
  return [...prompts].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function visibleForCwd(prompt: SavedPrompt, cwd: string): boolean {
  if (prompt.scope === "global") return true;
  const paths = resolveProjectPaths(prompt);
  if (paths.length === 0) return false;
  const normalizedCwd = normalizePath(cwd);
  return paths.some((p) => {
    const normalizedProject = normalizePath(p);
    return normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}/`);
  });
}

/** Merges legacy projectPath and projectPaths into a single deduplicated list. */
function resolveProjectPaths(prompt: SavedPrompt): string[] {
  const paths: string[] = [];
  if (prompt.projectPaths && prompt.projectPaths.length > 0) {
    paths.push(...prompt.projectPaths);
  }
  if (prompt.projectPath && !paths.some((p) => normalizePath(p) === normalizePath(prompt.projectPath!))) {
    paths.push(prompt.projectPath);
  }
  return paths;
}

export function listPrompts(opts?: { cwd?: string; scope?: "global" | "project" | "all" }): SavedPrompt[] {
  const prompts = loadPrompts();
  const scope = opts?.scope ?? "all";

  const filteredByScope = prompts.filter((p) => {
    if (scope === "all") return true;
    return p.scope === scope;
  });

  if (!opts?.cwd) return sortPrompts(filteredByScope);

  return sortPrompts(filteredByScope.filter((p) => visibleForCwd(p, opts.cwd!)));
}

export function getPrompt(id: string): SavedPrompt | null {
  return loadPrompts().find((p) => p.id === id) ?? null;
}

export function createPrompt(
  name: string,
  content: string,
  scope: PromptScope,
  projectPath?: string,
  projectPaths?: string[],
): SavedPrompt {
  const cleanName = name?.trim();
  const cleanContent = content?.trim();
  if (!cleanName) throw new Error("Prompt name is required");
  if (!cleanContent) throw new Error("Prompt content is required");
  if (scope !== "global" && scope !== "project") throw new Error("Invalid prompt scope");

  // Merge projectPaths and legacy projectPath into a single deduplicated list
  const mergedPaths = dedupeAndNormalizePaths(projectPaths, projectPath);
  if (scope === "project" && mergedPaths.length === 0) {
    throw new Error("Project path is required for project prompts");
  }

  const prompts = loadPrompts();
  const now = Date.now();
  const prompt: SavedPrompt = {
    id: crypto.randomUUID(),
    name: cleanName,
    content: cleanContent,
    scope,
    projectPath: scope === "project" ? mergedPaths[0] : undefined,
    projectPaths: scope === "project" ? mergedPaths : undefined,
    createdAt: now,
    updatedAt: now,
  };
  prompts.push(prompt);
  savePrompts(prompts);
  return prompt;
}

function dedupeAndNormalizePaths(paths?: string[], legacyPath?: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const all = [...(paths ?? []), ...(legacyPath?.trim() ? [legacyPath] : [])];
  for (const p of all) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const normalized = normalizePath(trimmed);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function updatePrompt(id: string, updates: PromptUpdateFields): SavedPrompt | null {
  const prompts = loadPrompts();
  const index = prompts.findIndex((p) => p.id === id);
  if (index < 0) return null;

  if (updates.name !== undefined && !updates.name.trim()) {
    throw new Error("Prompt name cannot be empty");
  }
  if (updates.content !== undefined && !updates.content.trim()) {
    throw new Error("Prompt content cannot be empty");
  }

  const newScope = updates.scope ?? prompts[index].scope;
  if (updates.scope !== undefined && updates.scope !== "global" && updates.scope !== "project") {
    throw new Error("Invalid prompt scope");
  }

  let newProjectPaths = prompts[index].projectPaths;
  let newProjectPath = prompts[index].projectPath;
  if (updates.projectPaths !== undefined) {
    const normalized = dedupeAndNormalizePaths(updates.projectPaths);
    newProjectPaths = normalized.length > 0 ? normalized : undefined;
    newProjectPath = normalized.length > 0 ? normalized[0] : undefined;
  }
  if (newScope === "project" && (!newProjectPaths || newProjectPaths.length === 0)) {
    throw new Error("Project path is required for project prompts");
  }
  if (newScope === "global") {
    newProjectPaths = undefined;
    newProjectPath = undefined;
  }

  const updated: SavedPrompt = {
    ...prompts[index],
    name: updates.name !== undefined ? updates.name.trim() : prompts[index].name,
    content: updates.content !== undefined ? updates.content.trim() : prompts[index].content,
    scope: newScope,
    projectPath: newProjectPath,
    projectPaths: newProjectPaths,
    updatedAt: Date.now(),
  };
  prompts[index] = updated;
  savePrompts(prompts);
  return updated;
}

export function deletePrompt(id: string): boolean {
  const prompts = loadPrompts();
  const next = prompts.filter((p) => p.id !== id);
  if (next.length === prompts.length) return false;
  savePrompts(next);
  return true;
}
