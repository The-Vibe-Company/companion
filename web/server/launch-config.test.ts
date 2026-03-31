import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLaunchConfig,
  validateConfig,
  resolveForContext,
  buildStartupOrder,
  parseEnvFile,
  resolveEnvVars,
  type LaunchConfig,
  type ResolvedService,
} from "./launch-config.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "launch-config-test-"));
}

function writeLaunchConfig(cwd: string, config: Record<string, unknown>): void {
  const dir = join(cwd, ".companion");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "launch.json"), JSON.stringify(config, null, 2));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("launch-config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- loadLaunchConfig --

  describe("loadLaunchConfig", () => {
    test("returns null when no .companion/launch.json exists", () => {
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("loads valid config from cwd", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        setup: [{ name: "Install", command: "npm install" }],
      });
      const config = loadLaunchConfig(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.version).toBe("0.0.1");
      expect(config!.setup).toHaveLength(1);
    });

    test("falls back to repoRoot for worktree sessions", () => {
      const repoRoot = makeTmpDir();
      writeLaunchConfig(repoRoot, {
        version: "0.0.1",
        services: { web: { command: "npm run dev" } },
      });
      // tmpDir (worktree) has no launch.json
      const config = loadLaunchConfig(tmpDir, repoRoot);
      expect(config).not.toBeNull();
      expect(config!.services).toHaveProperty("web");
      rmSync(repoRoot, { recursive: true, force: true });
    });

    test("prefers cwd over repoRoot", () => {
      const repoRoot = makeTmpDir();
      writeLaunchConfig(repoRoot, {
        version: "0.0.1",
        setup: [{ name: "Root", command: "echo root" }],
      });
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        setup: [{ name: "Worktree", command: "echo worktree" }],
      });
      const config = loadLaunchConfig(tmpDir, repoRoot);
      expect(config!.setup![0].name).toBe("Worktree");
      rmSync(repoRoot, { recursive: true, force: true });
    });

    test("returns null for invalid JSON", () => {
      const dir = join(tmpDir, ".companion");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "launch.json"), "{ not valid json }");
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("returns null when version is missing", () => {
      writeLaunchConfig(tmpDir, {
        setup: [{ name: "Install", command: "npm install" }],
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });
  });

  // -- Validation --

  describe("validation", () => {
    test("rejects setup without name", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        setup: [{ command: "npm install" }],
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("rejects setup without command", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        setup: [{ name: "Install" }],
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("rejects service without command", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        services: { web: { readyPattern: "ready" } },
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("rejects invalid dependsOn condition", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        services: {
          db: { command: "start-db" },
          web: { command: "npm run dev", dependsOn: { db: "healthy" } },
        },
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("rejects dependsOn ready without readyPattern on dependency", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        services: {
          db: { command: "start-db" },
          web: { command: "npm run dev", dependsOn: { db: "ready" } },
        },
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("accepts dependsOn ready when dependency has readyPattern", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        services: {
          db: { command: "start-db", readyPattern: "accepting connections" },
          web: { command: "npm run dev", dependsOn: { db: "ready" } },
        },
      });
      expect(loadLaunchConfig(tmpDir)).not.toBeNull();
    });

    test("rejects invalid port number", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        ports: { abc: { label: "App" } },
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("rejects port without label", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        ports: { "3000": { openOnReady: true } },
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("rejects invalid protocol", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        ports: { "3000": { label: "App", protocol: "udp" } },
      });
      expect(loadLaunchConfig(tmpDir)).toBeNull();
    });

    test("validateConfig collects all errors in one pass", () => {
      // Config has multiple issues: missing version, invalid port, service without command
      const result = validateConfig({
        services: { broken: { readyPattern: "ready" } },
        ports: { abc: { label: "App" }, "3000": {} },
      });
      expect(result.valid).toBe(false);
      // Should collect at least 3 distinct errors (version, service command, port number, port label)
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
      expect(result.errors.some((e) => e.includes("broken"))).toBe(true);
      expect(result.errors.some((e) => e.includes("abc"))).toBe(true);
    });

    test("accepts valid complete config", () => {
      writeLaunchConfig(tmpDir, {
        version: "0.0.1",
        setup: [{ name: "Install", command: "bun install" }],
        services: {
          db: { command: "docker compose up postgres", readyPattern: "ready", conditions: { local: true } },
          api: { command: "bun run dev:api", dependsOn: { db: "ready" }, readyPattern: "listening" },
          web: { command: "bun run dev:vite", dependsOn: { api: "started" } },
        },
        ports: {
          "3000": { label: "App", openOnReady: true, healthCheck: { path: "/" } },
          "5432": { label: "Postgres", protocol: "tcp" },
        },
      });
      expect(loadLaunchConfig(tmpDir)).not.toBeNull();
    });
  });

  // -- resolveForContext --

  describe("resolveForContext", () => {
    const fullConfig: LaunchConfig = {
      version: "0.0.1",
      setup: [
        { name: "Install", command: "bun install" },
        { name: "Sandbox only", command: "apt install -y foo", conditions: { sandbox: true } },
        { name: "Local only", command: "brew install bar", conditions: { local: true } },
      ],
      services: {
        db: { command: "start-db", readyPattern: "ready", conditions: { local: true } },
        api: { command: "bun dev:api", dependsOn: { db: "ready" }, readyPattern: "listening" },
        "api-sandbox": { command: "npm dev:api", readyPattern: "listening", conditions: { sandbox: true } },
        web: { command: "bun dev:vite", dependsOn: { api: "started" } },
      },
      ports: {
        "3000": { label: "App", openOnReady: true },
        "5432": { label: "Postgres", protocol: "tcp" },
      },
    };

    test("filters setup scripts for local context", () => {
      const resolved = resolveForContext(fullConfig, { isSandbox: false, isWorktree: false });
      expect(resolved.setup).toHaveLength(2);
      expect(resolved.setup.map((s) => s.name)).toEqual(["Install", "Local only"]);
    });

    test("filters setup scripts for sandbox context", () => {
      const resolved = resolveForContext(fullConfig, { isSandbox: true, isWorktree: false });
      expect(resolved.setup).toHaveLength(2);
      expect(resolved.setup.map((s) => s.name)).toEqual(["Install", "Sandbox only"]);
    });

    test("filters services for local context and keeps deps", () => {
      const resolved = resolveForContext(fullConfig, { isSandbox: false, isWorktree: false });
      const serviceNames = Object.keys(resolved.services);
      expect(serviceNames).toContain("db");
      expect(serviceNames).toContain("api");
      expect(serviceNames).toContain("web");
      expect(serviceNames).not.toContain("api-sandbox");
      // api still depends on db
      expect(resolved.services.api.dependsOn).toEqual({ db: "ready" });
    });

    test("prunes dependsOn when dependency is filtered out", () => {
      // In sandbox context, 'db' is filtered out (local only)
      const resolved = resolveForContext(fullConfig, { isSandbox: true, isWorktree: false });
      expect(resolved.services).not.toHaveProperty("db");
      // api's dependsOn db should be pruned
      expect(resolved.services.api.dependsOn).toEqual({});
    });

    test("ports are always included regardless of context", () => {
      const resolved = resolveForContext(fullConfig, { isSandbox: true, isWorktree: false });
      expect(Object.keys(resolved.ports)).toEqual(["3000", "5432"]);
    });

    test("applies default readyTimeout of 60", () => {
      const resolved = resolveForContext(fullConfig, { isSandbox: false, isWorktree: false });
      expect(resolved.services.db.readyTimeout).toBe(60);
    });

    test("handles config with no setup or services", () => {
      const minimal: LaunchConfig = { version: "0.0.1" };
      const resolved = resolveForContext(minimal, { isSandbox: false, isWorktree: false });
      expect(resolved.setup).toEqual([]);
      expect(resolved.services).toEqual({});
      expect(resolved.ports).toEqual({});
    });
  });

  // -- buildStartupOrder --

  describe("buildStartupOrder", () => {
    test("single service with no deps → one wave", () => {
      const services: Record<string, ResolvedService> = {
        web: { name: "web", command: "npm dev", env: {}, dependsOn: {}, readyTimeout: 60 },
      };
      expect(buildStartupOrder(services)).toEqual([["web"]]);
    });

    test("independent services → single wave with all", () => {
      const services: Record<string, ResolvedService> = {
        web: { name: "web", command: "npm dev", env: {}, dependsOn: {}, readyTimeout: 60 },
        api: { name: "api", command: "npm api", env: {}, dependsOn: {}, readyTimeout: 60 },
      };
      const waves = buildStartupOrder(services);
      expect(waves).toHaveLength(1);
      expect(waves[0].sort()).toEqual(["api", "web"]);
    });

    test("linear chain → sequential waves", () => {
      const services: Record<string, ResolvedService> = {
        db: { name: "db", command: "start-db", env: {}, dependsOn: {}, readyPattern: "ready", readyTimeout: 60 },
        api: { name: "api", command: "start-api", env: {}, dependsOn: { db: "ready" }, readyPattern: "listening", readyTimeout: 60 },
        web: { name: "web", command: "start-web", env: {}, dependsOn: { api: "started" }, readyTimeout: 60 },
      };
      const waves = buildStartupOrder(services);
      expect(waves).toEqual([["db"], ["api"], ["web"]]);
    });

    test("diamond dependency → correct wave grouping", () => {
      // db → api, db → worker, then app depends on both api and worker
      const services: Record<string, ResolvedService> = {
        db: { name: "db", command: "start-db", env: {}, dependsOn: {}, readyPattern: "ready", readyTimeout: 60 },
        api: { name: "api", command: "start-api", env: {}, dependsOn: { db: "ready" }, readyTimeout: 60 },
        worker: { name: "worker", command: "start-worker", env: {}, dependsOn: { db: "ready" }, readyTimeout: 60 },
        app: { name: "app", command: "start-app", env: {}, dependsOn: { api: "started", worker: "started" }, readyTimeout: 60 },
      };
      const waves = buildStartupOrder(services);
      expect(waves).toHaveLength(3);
      expect(waves[0]).toEqual(["db"]);
      expect(waves[1].sort()).toEqual(["api", "worker"]);
      expect(waves[2]).toEqual(["app"]);
    });

    test("circular dependency → throws", () => {
      const services: Record<string, ResolvedService> = {
        a: { name: "a", command: "start-a", env: {}, dependsOn: { b: "started" }, readyTimeout: 60 },
        b: { name: "b", command: "start-b", env: {}, dependsOn: { a: "started" }, readyTimeout: 60 },
      };
      expect(() => buildStartupOrder(services)).toThrow(/Circular dependency/);
    });

    test("three-way circular → throws with all names", () => {
      const services: Record<string, ResolvedService> = {
        a: { name: "a", command: "a", env: {}, dependsOn: { c: "started" }, readyTimeout: 60 },
        b: { name: "b", command: "b", env: {}, dependsOn: { a: "started" }, readyTimeout: 60 },
        c: { name: "c", command: "c", env: {}, dependsOn: { b: "started" }, readyTimeout: 60 },
      };
      expect(() => buildStartupOrder(services)).toThrow(/a, b, c/);
    });

    test("empty services → empty waves", () => {
      expect(buildStartupOrder({})).toEqual([]);
    });
  });

  // ── parseEnvFile ──────────────────────────────────────────────────────────

  describe("parseEnvFile", () => {
    test("parses KEY=VALUE pairs", () => {
      const envPath = join(tmpDir, ".env");
      writeFileSync(envPath, "FOO=bar\nBAZ=qux\n");
      expect(parseEnvFile(envPath)).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    test("strips double quotes from values", () => {
      const envPath = join(tmpDir, ".env");
      writeFileSync(envPath, 'DB_URL="postgres://localhost/mydb"\n');
      expect(parseEnvFile(envPath)).toEqual({ DB_URL: "postgres://localhost/mydb" });
    });

    test("strips single quotes from values", () => {
      const envPath = join(tmpDir, ".env");
      writeFileSync(envPath, "SECRET='my secret value'\n");
      expect(parseEnvFile(envPath)).toEqual({ SECRET: "my secret value" });
    });

    test("handles export prefix", () => {
      const envPath = join(tmpDir, ".env");
      writeFileSync(envPath, "export API_KEY=abc123\n");
      expect(parseEnvFile(envPath)).toEqual({ API_KEY: "abc123" });
    });

    test("skips comments and blank lines", () => {
      const envPath = join(tmpDir, ".env");
      writeFileSync(envPath, "# This is a comment\n\nFOO=bar\n# Another comment\n");
      expect(parseEnvFile(envPath)).toEqual({ FOO: "bar" });
    });

    test("returns empty object for missing file", () => {
      expect(parseEnvFile(join(tmpDir, "nonexistent.env"))).toEqual({});
    });

    test("skips lines without valid key=value format", () => {
      const envPath = join(tmpDir, ".env");
      writeFileSync(envPath, "VALID=yes\n=no_key\njust_text\n");
      expect(parseEnvFile(envPath)).toEqual({ VALID: "yes" });
    });
  });

  // ── resolveEnvVars ────────────────────────────────────────────────────────

  describe("resolveEnvVars", () => {
    test("resolves ${VAR} from session env", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { vars: { MY_VAR: "${SESSION_VAR}" } },
      };
      const result = resolveEnvVars(config, tmpDir, { SESSION_VAR: "from-session" });
      expect(result.topLevelEnv.MY_VAR).toBe("from-session");
      expect(result.warnings).toHaveLength(0);
    });

    test("resolves ${VAR} from envFile", () => {
      // Write an .env file
      writeFileSync(join(tmpDir, ".env.local"), "FILE_VAR=from-file\n");
      const config: LaunchConfig = {
        version: "1",
        env: { envFile: ".env.local", vars: { MY_VAR: "${FILE_VAR}" } },
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.topLevelEnv.MY_VAR).toBe("from-file");
    });

    test("resolves ${VAR:-default} with fallback when var not found", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { vars: { DB_URL: "${MISSING_DB:-postgres://localhost/dev}" } },
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.topLevelEnv.DB_URL).toBe("postgres://localhost/dev");
      // No warning because default was used
      expect(result.warnings).toHaveLength(0);
    });

    test("session env takes priority over envFile", () => {
      writeFileSync(join(tmpDir, ".env.local"), "SHARED=from-file\n");
      const config: LaunchConfig = {
        version: "1",
        env: { envFile: ".env.local", vars: { SHARED: "${SHARED}" } },
      };
      const result = resolveEnvVars(config, tmpDir, { SHARED: "from-session" });
      expect(result.topLevelEnv.SHARED).toBe("from-session");
    });

    test("warns on unresolved vars without default", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { vars: { SECRET: "${TOTALLY_MISSING_VAR_12345}" } },
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.topLevelEnv.SECRET).toBe("");
      expect(result.warnings).toContain("TOTALLY_MISSING_VAR_12345");
    });

    test("literal strings (no interpolation) pass through unchanged", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { vars: { NODE_ENV: "development" } },
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.topLevelEnv.NODE_ENV).toBe("development");
    });

    test("per-service env overrides top-level vars", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { vars: { PORT: "3000" } },
        services: {
          api: { command: "node server.js", env: { PORT: "4000" } },
        },
      };
      const result = resolveEnvVars(config, tmpDir);
      // Per-service PORT should override top-level PORT
      expect(result.serviceEnvs.api.PORT).toBe("4000");
    });

    test("per-service env inherits top-level when no override", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { vars: { NODE_ENV: "development" } },
        services: {
          api: { command: "node server.js", env: { PORT: "3000" } },
        },
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.serviceEnvs.api.NODE_ENV).toBe("development");
      expect(result.serviceEnvs.api.PORT).toBe("3000");
    });

    test("setup script env merges with top-level", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { vars: { NODE_ENV: "development" } },
        setup: [{ name: "migrate", command: "npm run migrate", env: { DB_URL: "postgres://localhost/test" } }],
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.setupEnvs.migrate.NODE_ENV).toBe("development");
      expect(result.setupEnvs.migrate.DB_URL).toBe("postgres://localhost/test");
    });

    test("rejects absolute envFile path", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { envFile: "/etc/secrets" },
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.warnings.some(w => w.includes("relative path"))).toBe(true);
    });

    test("rejects envFile path traversal", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { envFile: "../../etc/secrets" },
      };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.warnings.some(w => w.includes("escape"))).toBe(true);
    });

    test("warns when envFile does not exist", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { envFile: ".env.local" },
      };
      const result = resolveEnvVars(config, tmpDir);
      // No error, just a warning — graceful degradation
      expect(result.warnings.some(w => w.includes("not found"))).toBe(true);
    });

    test("returns empty envs when no env config present", () => {
      const config: LaunchConfig = { version: "1" };
      const result = resolveEnvVars(config, tmpDir);
      expect(result.topLevelEnv).toEqual({});
      expect(result.serviceEnvs).toEqual({});
      expect(result.setupEnvs).toEqual({});
      expect(result.warnings).toHaveLength(0);
    });
  });

  // ── validation: env fields ────────────────────────────────────────────────

  describe("validateConfig — env fields", () => {
    test("accepts valid env config", () => {
      const config: LaunchConfig = {
        version: "1",
        env: { envFile: ".env.local", vars: { FOO: "bar" } },
        services: { api: { command: "node server.js" } },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
    });

    test("rejects env.envFile that is not a string", () => {
      const config = {
        version: "1",
        env: { envFile: 123 },
      } as unknown as LaunchConfig;
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes("envfile"))).toBe(true);
    });

    test("rejects env.vars with non-string values", () => {
      const config = {
        version: "1",
        env: { vars: { FOO: 123 } },
      } as unknown as LaunchConfig;
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes("var"))).toBe(true);
    });

    test("rejects per-service env that is not an object", () => {
      // Per-service env must be an object map, not an array or primitive
      const config = {
        version: "1",
        services: { api: { command: "node server.js", env: "invalid" } },
      } as unknown as LaunchConfig;
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("env"))).toBe(true);
    });
  });
});
