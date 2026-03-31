/**
 * launch-config.ts — Load, validate, and resolve `.companion/launch.json` files.
 *
 * A launch config defines per-project setup scripts, background services (with
 * dependency ordering), and port declarations for the Environment panel.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LaunchConditions {
  local?: boolean;
  sandbox?: boolean;
  worktree?: boolean;
}

export interface LaunchSetupScript {
  name: string;
  command: string;
  env?: Record<string, string>;
  conditions?: LaunchConditions;
}

export type DependencyCondition = "started" | "ready";

export interface LaunchServiceConfig {
  command: string;
  env?: Record<string, string>;
  dependsOn?: Record<string, DependencyCondition>;
  readyPattern?: string;
  readyTimeout?: number; // seconds, default 60
  conditions?: LaunchConditions;
}

export interface HealthCheckConfig {
  path?: string;
  interval?: number; // seconds, default 10
}

export interface LaunchPortConfig {
  label: string;
  openOnReady?: boolean;
  healthCheck?: HealthCheckConfig;
  protocol?: "http" | "tcp";
}

export interface LaunchEnvConfig {
  envFile?: string;
  vars?: Record<string, string>;
}

export interface LaunchConfig {
  version: string;
  env?: LaunchEnvConfig;
  setup?: LaunchSetupScript[];
  services?: Record<string, LaunchServiceConfig>;
  ports?: Record<string, LaunchPortConfig>;
}

export interface ResolvedService {
  name: string;
  command: string;
  env: Record<string, string>;
  dependsOn: Record<string, DependencyCondition>;
  readyPattern?: string;
  readyTimeout: number;
}

export interface ResolvedLaunchConfig {
  setup: LaunchSetupScript[];
  services: Record<string, ResolvedService>;
  ports: Record<string, LaunchPortConfig>;
  env?: LaunchEnvConfig;
}

export interface ResolvedEnv {
  /** Merged top-level env (envFile + vars, all interpolated) */
  topLevelEnv: Record<string, string>;
  /** Per-service env (top-level + service-specific, all interpolated) */
  serviceEnvs: Record<string, Record<string, string>>;
  /** Per-setup-script env (top-level + script-specific, all interpolated) */
  setupEnvs: Record<string, Record<string, string>>;
  /** Warnings for unresolved variables (names only, never values) */
  warnings: string[];
}

export interface ExecutionContext {
  isSandbox: boolean;
  isWorktree: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

const LAUNCH_CONFIG_FILENAME = "launch.json";
const COMPANION_DIR = ".companion";
const DEFAULT_READY_TIMEOUT = 60;

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Load launch config from `<cwd>/.companion/launch.json`.
 * For worktree sessions, also checks the repo root as fallback.
 */
export function loadLaunchConfig(
  cwd: string,
  repoRoot?: string,
): LaunchConfig | null {
  const primary = join(cwd, COMPANION_DIR, LAUNCH_CONFIG_FILENAME);
  if (existsSync(primary)) {
    return parseLaunchConfig(primary);
  }

  // Fallback to repo root for worktree sessions
  if (repoRoot && repoRoot !== cwd) {
    const fallback = join(repoRoot, COMPANION_DIR, LAUNCH_CONFIG_FILENAME);
    if (existsSync(fallback)) {
      return parseLaunchConfig(fallback);
    }
  }

  return null;
}

function parseLaunchConfig(filePath: string): LaunchConfig | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const config = JSON.parse(raw) as LaunchConfig;
    validate(config);
    return config;
  } catch (e) {
    console.warn(
      `[launch-config] Failed to load ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

function validate(config: LaunchConfig): void {
  if (!config.version || typeof config.version !== "string") {
    throw new Error("launch.json requires a 'version' field");
  }

  if (config.env !== undefined) {
    if (typeof config.env !== "object" || Array.isArray(config.env)) {
      throw new Error("'env' must be an object");
    }
    if (config.env.envFile !== undefined && typeof config.env.envFile !== "string") {
      throw new Error("'env.envFile' must be a string");
    }
    if (config.env.vars !== undefined) {
      if (typeof config.env.vars !== "object" || Array.isArray(config.env.vars)) {
        throw new Error("'env.vars' must be an object map of strings");
      }
      for (const [k, v] of Object.entries(config.env.vars)) {
        if (typeof v !== "string") {
          throw new Error(`env.vars["${k}"] must be a string`);
        }
      }
    }
  }

  if (config.setup !== undefined) {
    if (!Array.isArray(config.setup)) {
      throw new Error("'setup' must be an array");
    }
    for (const s of config.setup) {
      if (!s.name || typeof s.name !== "string") {
        throw new Error("Each setup script requires a 'name' string");
      }
      if (!s.command || typeof s.command !== "string") {
        throw new Error(`Setup script "${s.name}" requires a 'command' string`);
      }
      if (s.env !== undefined && (typeof s.env !== "object" || Array.isArray(s.env))) {
        throw new Error(`Setup script "${s.name}" 'env' must be an object map`);
      }
    }
  }

  if (config.services !== undefined) {
    if (typeof config.services !== "object" || Array.isArray(config.services)) {
      throw new Error("'services' must be an object map");
    }
    for (const [name, svc] of Object.entries(config.services)) {
      if (!svc.command || typeof svc.command !== "string") {
        throw new Error(`Service "${name}" requires a 'command' string`);
      }
      if (svc.dependsOn) {
        for (const [dep, cond] of Object.entries(svc.dependsOn)) {
          if (cond !== "started" && cond !== "ready") {
            throw new Error(
              `Service "${name}" has invalid dependsOn condition for "${dep}": must be "started" or "ready"`,
            );
          }
          if (cond === "ready") {
            const depSvc = config.services[dep];
            if (depSvc && !depSvc.readyPattern) {
              throw new Error(
                `Service "${name}" depends on "${dep}" with condition "ready", but "${dep}" has no readyPattern`,
              );
            }
          }
        }
      }
    }
  }

  if (config.ports !== undefined) {
    if (typeof config.ports !== "object" || Array.isArray(config.ports)) {
      throw new Error("'ports' must be an object map keyed by port number");
    }
    for (const [portStr, portConfig] of Object.entries(config.ports)) {
      const portNum = Number(portStr);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        throw new Error(`Invalid port number: "${portStr}"`);
      }
      if (!portConfig.label || typeof portConfig.label !== "string") {
        throw new Error(`Port "${portStr}" requires a 'label' string`);
      }
      if (portConfig.protocol && portConfig.protocol !== "http" && portConfig.protocol !== "tcp") {
        throw new Error(`Port "${portStr}" protocol must be "http" or "tcp"`);
      }
    }
  }
}

/**
 * Validate a launch config object and return structured results.
 * Unlike the internal `validate()` which throws on the first issue,
 * this collects all validation errors so agents see them in one pass.
 */
export function validateConfig(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["Config must be a non-null object"] };
  }

  const config = raw as LaunchConfig;

  // Version
  if (!config.version || typeof config.version !== "string") {
    errors.push("launch.json requires a 'version' field");
  }

  // Env
  if (config.env !== undefined) {
    if (typeof config.env !== "object" || Array.isArray(config.env)) {
      errors.push("'env' must be an object");
    } else {
      if (config.env.envFile !== undefined && typeof config.env.envFile !== "string") {
        errors.push("'env.envFile' must be a string");
      }
      if (config.env.vars !== undefined) {
        if (typeof config.env.vars !== "object" || Array.isArray(config.env.vars)) {
          errors.push("'env.vars' must be an object map of strings");
        } else {
          for (const [k, v] of Object.entries(config.env.vars)) {
            if (typeof v !== "string") {
              errors.push(`env.vars["${k}"] must be a string`);
            }
          }
        }
      }
    }
  }

  // Setup
  if (config.setup !== undefined) {
    if (!Array.isArray(config.setup)) {
      errors.push("'setup' must be an array");
    } else {
      for (const s of config.setup) {
        if (!s.name || typeof s.name !== "string") {
          errors.push("Each setup script requires a 'name' string");
        }
        if (!s.command || typeof s.command !== "string") {
          errors.push(`Setup script "${s.name || "?"}" requires a 'command' string`);
        }
        if (s.env !== undefined && (typeof s.env !== "object" || Array.isArray(s.env))) {
          errors.push(`Setup script "${s.name || "?"}" 'env' must be an object map`);
        }
      }
    }
  }

  // Services
  if (config.services !== undefined) {
    if (typeof config.services !== "object" || Array.isArray(config.services)) {
      errors.push("'services' must be an object map");
    } else {
      for (const [name, svc] of Object.entries(config.services)) {
        if (!svc.command || typeof svc.command !== "string") {
          errors.push(`Service "${name}" requires a 'command' string`);
        }
        if (svc.env !== undefined && (typeof svc.env !== "object" || Array.isArray(svc.env))) {
          errors.push(`Service "${name}" 'env' must be an object map`);
        }
        if (svc.dependsOn) {
          for (const [dep, cond] of Object.entries(svc.dependsOn)) {
            if (cond !== "started" && cond !== "ready") {
              errors.push(
                `Service "${name}" has invalid dependsOn condition for "${dep}": must be "started" or "ready"`,
              );
            }
            if (cond === "ready") {
              const depSvc = config.services[dep];
              if (depSvc && !depSvc.readyPattern) {
                errors.push(
                  `Service "${name}" depends on "${dep}" with condition "ready", but "${dep}" has no readyPattern`,
                );
              }
            }
          }
        }
      }
    }
  }

  // Ports
  if (config.ports !== undefined) {
    if (typeof config.ports !== "object" || Array.isArray(config.ports)) {
      errors.push("'ports' must be an object map keyed by port number");
    } else {
      for (const [portStr, portConfig] of Object.entries(config.ports)) {
        const portNum = Number(portStr);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
          errors.push(`Invalid port number: "${portStr}"`);
        }
        if (!portConfig.label || typeof portConfig.label !== "string") {
          errors.push(`Port "${portStr}" requires a 'label' string`);
        }
        if (portConfig.protocol && portConfig.protocol !== "http" && portConfig.protocol !== "tcp") {
          errors.push(`Port "${portStr}" protocol must be "http" or "tcp"`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Context Resolution ──────────────────────────────────────────────────────

/**
 * Filter setup scripts and services by execution context (local/sandbox/worktree),
 * prune dependency graph, and normalize resolved services.
 */
export function resolveForContext(
  config: LaunchConfig,
  ctx: ExecutionContext,
): ResolvedLaunchConfig {
  const envType = ctx.isSandbox ? "sandbox" : ctx.isWorktree ? "worktree" : "local";

  // Filter setup scripts
  const setup = (config.setup ?? []).filter((s) => matchesConditions(s.conditions, envType));

  // Filter services
  const filteredServices: Record<string, ResolvedService> = {};
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    if (!matchesConditions(svc.conditions, envType)) continue;

    // Prune dependsOn: remove references to services that were filtered out
    const prunedDeps: Record<string, DependencyCondition> = {};
    if (svc.dependsOn) {
      for (const [dep, cond] of Object.entries(svc.dependsOn)) {
        // Only keep deps that exist and pass conditions
        const depSvc = config.services?.[dep];
        if (depSvc && matchesConditions(depSvc.conditions, envType)) {
          prunedDeps[dep] = cond;
        }
        // If dep was filtered out, treat as satisfied (skip it)
      }
    }

    filteredServices[name] = {
      name,
      command: svc.command,
      env: svc.env ?? {},
      dependsOn: prunedDeps,
      readyPattern: svc.readyPattern,
      readyTimeout: svc.readyTimeout ?? DEFAULT_READY_TIMEOUT,
    };
  }

  return {
    setup,
    services: filteredServices,
    ports: config.ports ?? {},
    env: config.env,
  };
}

function matchesConditions(
  conditions: LaunchConditions | undefined,
  envType: "local" | "sandbox" | "worktree",
): boolean {
  if (!conditions) return true; // No conditions = runs everywhere
  return conditions[envType] === true;
}

// ── Dependency Graph / Topological Sort ─────────────────────────────────────

/**
 * Build execution waves via topological sort. Returns an array of arrays:
 * each inner array is a group of service names that can start in parallel.
 *
 * @throws Error on circular dependencies
 */
export function buildStartupOrder(
  services: Record<string, ResolvedService>,
): string[][] {
  const names = Object.keys(services);
  if (names.length === 0) return [];

  // Build adjacency: for each service, which services must start before it?
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → services that depend on it

  for (const name of names) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const [name, svc] of Object.entries(services)) {
    const depCount = Object.keys(svc.dependsOn).length;
    inDegree.set(name, depCount);
    for (const dep of Object.keys(svc.dependsOn)) {
      dependents.get(dep)?.push(name);
    }
  }

  // Kahn's algorithm — collect waves instead of a flat list
  const waves: string[][] = [];
  let remaining = names.length;

  // First wave: all services with no dependencies
  let currentWave = names.filter((n) => inDegree.get(n) === 0);

  while (currentWave.length > 0) {
    waves.push(currentWave);
    remaining -= currentWave.length;

    const nextWave: string[] = [];
    for (const name of currentWave) {
      for (const dependent of dependents.get(name) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          nextWave.push(dependent);
        }
      }
    }
    currentWave = nextWave;
  }

  if (remaining > 0) {
    // Find the cycle for a useful error message
    const inCycle = names.filter((n) => (inDegree.get(n) ?? 0) > 0);
    throw new Error(
      `Circular dependency detected among services: ${inCycle.join(", ")}`,
    );
  }

  return waves;
}

// ── Environment Variable Resolution ──────────────────────────────────────────

/**
 * Parse a .env file into a key-value map.
 * Supports: KEY=VALUE, KEY="VALUE", KEY='VALUE', export KEY=VALUE,
 * blank lines, and # comments.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  const content = readFileSync(filePath, "utf-8");
  const vars: Record<string, string> = {};

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Strip optional "export " prefix
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;

    const eqIdx = stripped.indexOf("=");
    if (eqIdx < 1) continue;

    const key = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1).trim();

    // Unquote double or single quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}

/** Regex for ${VAR} and ${VAR:-default} interpolation */
const INTERP_RE = /\$\{([^}:]+?)(?::-([\s\S]*?))?\}/g;

/**
 * Interpolate ${VAR} and ${VAR:-default} references in a string value.
 * Resolution order: sessionEnv → envFileVars → process.env → default → "".
 */
function interpolate(
  value: string,
  sources: Record<string, string>[],
  warnings: string[],
): string {
  return value.replace(INTERP_RE, (_match, varName: string, defaultVal?: string) => {
    for (const source of sources) {
      if (varName in source) return source[varName];
    }
    if (defaultVal !== undefined) return defaultVal;
    warnings.push(varName);
    return "";
  });
}

/**
 * Interpolate all values in a record, returning a new record.
 */
function interpolateRecord(
  vars: Record<string, string>,
  sources: Record<string, string>[],
  warnings: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    result[key] = interpolate(value, sources, warnings);
  }
  return result;
}

/**
 * Validate that an envFile path is safe (relative, no traversal outside cwd).
 */
function validateEnvFilePath(envFile: string, cwd: string): string | null {
  if (isAbsolute(envFile)) return "envFile must be a relative path";
  const resolved = resolve(cwd, envFile);
  const normalizedCwd = resolve(cwd);
  if (!resolved.startsWith(normalizedCwd + "/") && resolved !== normalizedCwd) {
    return "envFile must not escape the project directory";
  }
  return null;
}

/**
 * Resolve all environment variables for a launch config.
 *
 * Resolution order (first match wins): sessionEnv → envFile → process.env → default.
 * Merge order (later wins): top-level vars → per-service/script env.
 */
export function resolveEnvVars(
  config: LaunchConfig,
  cwd: string,
  sessionEnv?: Record<string, string>,
): ResolvedEnv {
  const warnings: string[] = [];

  // 1. Load envFile vars
  let envFileVars: Record<string, string> = {};
  if (config.env?.envFile) {
    const pathErr = validateEnvFilePath(config.env.envFile, cwd);
    if (pathErr) {
      warnings.push(`envFile: ${pathErr}`);
    } else {
      const envFilePath = resolve(cwd, config.env.envFile);
      envFileVars = parseEnvFile(envFilePath);
      if (!existsSync(envFilePath)) {
        warnings.push(`envFile "${config.env.envFile}" not found — skipping`);
      }
    }
  }

  // Resolution sources in priority order
  const sources: Record<string, string>[] = [
    sessionEnv ?? {},
    envFileVars,
    process.env as Record<string, string>,
  ];

  // 2. Resolve top-level vars
  const topLevelEnv = config.env?.vars
    ? interpolateRecord(config.env.vars, sources, warnings)
    : {};

  // 3. Resolve per-service env (top-level merged first, then service-specific on top)
  const serviceEnvs: Record<string, Record<string, string>> = {};
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    if (svc.env) {
      serviceEnvs[name] = {
        ...topLevelEnv,
        ...interpolateRecord(svc.env, sources, warnings),
      };
    } else if (Object.keys(topLevelEnv).length > 0) {
      serviceEnvs[name] = { ...topLevelEnv };
    }
  }

  // 4. Resolve per-setup-script env
  const setupEnvs: Record<string, Record<string, string>> = {};
  for (const script of config.setup ?? []) {
    if (script.env) {
      setupEnvs[script.name] = {
        ...topLevelEnv,
        ...interpolateRecord(script.env, sources, warnings),
      };
    } else if (Object.keys(topLevelEnv).length > 0) {
      setupEnvs[script.name] = { ...topLevelEnv };
    }
  }

  // Deduplicate warnings
  const uniqueWarnings = [...new Set(warnings)];

  return { topLevelEnv, serviceEnvs, setupEnvs, warnings: uniqueWarnings };
}
