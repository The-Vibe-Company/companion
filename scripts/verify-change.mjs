#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isAntiSlopCandidatePath } from "./anti-slop-targets.mjs";
import { classifyFiles } from "./ci-scope.mjs";

export const DEFERRED_GATES_EXIT_CODE = 2;

const HYGIENE_TESTS = [
  "scripts/agent-browser-box-center.test.mjs",
  "scripts/railway-config.test.mjs",
  "scripts/ci-scope.test.mjs",
  "scripts/ci-playwright-policy.test.mjs",
  "scripts/ci-gate.test.mjs",
  "scripts/lint-anti-slop.test.mjs",
  "scripts/verify-change.test.mjs",
];

function splitNullTerminated(output) {
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function changedPathsFromNameStatus(output, { includeCopySources = true } = {}) {
  const fields = splitNullTerminated(output);
  const paths = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const firstPath = fields[index++];
    if (!status || !firstPath) throw new Error("git returned an invalid name-status diff");
    if (!status.startsWith("C") || includeCopySources) paths.push(firstPath);
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = fields[index++];
      if (!secondPath) throw new Error("git returned an incomplete rename or copy record");
      paths.push(secondPath);
    }
  }
  return paths;
}

function gitOutput(args, { cwd, exec = execFileSync, encoding = "utf8" } = {}) {
  return exec("git", args, { cwd, encoding, stdio: ["ignore", "pipe", "pipe"] });
}

function assertSafeRef(ref) {
  if (!ref || ref.startsWith("-")) throw new Error(`invalid base ref: ${ref || "(empty)"}`);
}

export function collectChangedFiles(
  baseRef = "origin/main",
  { cwd = process.cwd(), exec = execFileSync, includeCopySources = true } = {},
) {
  assertSafeRef(baseRef);
  try {
    gitOutput(["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`], { cwd, exec });
  } catch {
    throw new Error(`base ref '${baseRef}' does not resolve to a commit; fetch it or pass --base <ref>`);
  }

  let mergeBase;
  try {
    mergeBase = gitOutput(["merge-base", baseRef, "HEAD"], { cwd, exec }).trim();
  } catch {
    throw new Error(`base ref '${baseRef}' and HEAD do not have a merge base`);
  }
  if (!mergeBase) throw new Error(`base ref '${baseRef}' and HEAD do not have a merge base`);

  const unmerged = splitNullTerminated(
    gitOutput(["diff", "--name-only", "--diff-filter=U", "-z", "--"], {
      cwd,
      exec,
      encoding: null,
    }),
  );
  if (unmerged.length > 0) {
    throw new Error(`unresolved merge conflicts: ${unmerged.join(", ")}`);
  }

  const tracked = changedPathsFromNameStatus(
    gitOutput(["diff", "--name-status", "--diff-filter=ACMRTD", "-z", mergeBase, "--"], {
      cwd,
      exec,
      encoding: null,
    }),
    { includeCopySources },
  );
  const untracked = splitNullTerminated(
    gitOutput(["ls-files", "--others", "--exclude-standard", "-z", "--"], {
      cwd,
      exec,
      encoding: null,
    }),
  );

  return [...new Set([...tracked, ...untracked])].sort();
}

export function readWorkspaces({ cwd = process.cwd(), exec = execFileSync } = {}) {
  const raw = exec("pnpm", ["-r", "list", "--depth", "-1", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("pnpm returned an invalid workspace list");
  }

  const root = resolve(cwd);
  return entries
    .filter((entry) => entry?.name && entry?.path && resolve(entry.path) !== root)
    .map((entry) => ({
      name: entry.name,
      path: relative(root, resolve(entry.path)).split(sep).join("/"),
    }))
    .sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name));
}

function workspaceForFile(file, workspaces) {
  return workspaces.find((workspace) => file === workspace.path || file.startsWith(`${workspace.path}/`));
}

function requiresQuality(file) {
  return classifyFiles([file]).quality;
}

function requiresDevStackCheck(file) {
  return [
    ".conductor/settings.toml",
    "docker-compose.yml",
    "scripts/dev-conductor.sh",
    "scripts/dev-environment.sh",
    "scripts/dev-process.sh",
    "scripts/dev-worker.sh",
    "scripts/dev-stack-check.sh",
    "scripts/dev-stack.sh",
    "scripts/setup-conductor.sh",
  ].includes(file);
}

export function affectedWorkspaceNames(files, scope, workspaces) {
  if (scope.full) return [];
  const names = new Set();
  for (const file of files) {
    const workspace = workspaceForFile(file, workspaces);
    if (workspace) names.add(workspace.name);
    else if (requiresQuality(file)) return [];
  }
  return [...names].sort();
}

function turboFilters(workspaceNames) {
  return workspaceNames.flatMap((name) => ["--filter", `...${name}`]);
}

function step(id, command, args) {
  return { id, command, args };
}

function deferredGate(id, command, note) {
  return { id, command, note };
}

export function createVerificationPlan(files, { workspaces = [], env = process.env, baseRef = "origin/main" } = {}) {
  const scope = classifyFiles(files);
  const workspaceNames = affectedWorkspaceNames(files, scope, workspaces);
  const filters = turboFilters(workspaceNames);
  const fastSteps = [];
  const deferredGates = [];

  if (files.length > 0) {
    fastSteps.push(step("hygiene", "node", ["--test", ...HYGIENE_TESTS]));
  }
  if (files.some(isAntiSlopCandidatePath)) {
    fastSteps.push(
      step("anti-slop-tests", "pnpm", ["test:anti-slop"]),
      step("anti-slop", "pnpm", ["lint:anti-slop", "--", "--base", baseRef]),
    );
  }
  if (files.some(requiresDevStackCheck)) {
    fastSteps.push(step("dev-stack", "bash", ["scripts/dev-stack-check.sh"]));
  }
  if (scope.design) {
    fastSteps.push(step("design", "pnpm", ["design:lint"]));
  }
  if (scope.skill) {
    fastSteps.push(
      step("skill-agent-client", "pnpm", ["--filter", "@companion/companion-skill", "check:agent-client"]),
      step("skill-version", "pnpm", ["--filter", "@companion/companion-skill", "check:version-bump"]),
      // Shared with both CI guard jobs so the suite is invoked one way everywhere, and so a
      // vacuous "Ran 0 tests" pass cannot slip through any of the three callers. The script
      // honours PYTHON, which is what makes this step runnable on a stock macOS where only
      // python3 exists on PATH.
      step("skill-guards", "bash", ["scripts/run-skill-guards.sh"]),
    );
  }
  if (scope.quality) {
    fastSteps.push(
      step("quality", "pnpm", [
        "exec",
        "turbo",
        "run",
        "lint",
        "typecheck",
        "test",
        "--continue=dependencies-successful",
        "--output-logs=errors-only",
        ...filters,
      ]),
    );
  }
  if (scope.build) {
    fastSteps.push(
      step("build", "pnpm", ["exec", "turbo", "run", "build", "--output-logs=errors-only", ...filters]),
    );
  }

  if (scope.database) {
    deferredGates.push(
      deferredGate(
        "database",
        "DATABASE_URL=<disposable-postgres-url> pnpm test:integration",
        "Requires an explicitly disposable, migrated Postgres database.",
      ),
    );
  }
  if (scope.browser) {
    const port = /^\d+$/.test(env.CONDUCTOR_PORT ?? "") ? env.CONDUCTOR_PORT : "3000";
    const appUrl = env.APP_URL?.trim() || `http://127.0.0.1:${port}`;
    deferredGates.push(
      deferredGate(
        "browser",
        `APP_URL=${appUrl} pnpm browser:smoke`,
        "Requires the built and seeded application stack to be running.",
      ),
    );
  }
  if (scope.containers) {
    deferredGates.push(
      deferredGate(
        "containers",
        "bash scripts/ci-container-smoke.sh",
        "Requires Docker, the three separated database URLs, and companion-release:ci, companion-api:ci, companion-worker:ci, and companion-web:ci images.",
      ),
    );
  }
  if (scope.dependencies) {
    deferredGates.push(
      deferredGate(
        "dependencies",
        "pnpm dlx pnpm@11.13.0 --pm-on-fail=ignore audit --prod --audit-level=high",
        "Requires registry network access.",
      ),
    );
  }

  return { files, scope, workspaceNames, fastSteps, deferredGates };
}

export function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function enabledScopes(scope) {
  return Object.entries(scope)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

export function printPlan(plan, { write = console.log } = {}) {
  write(`[verify-change] Changed files: ${plan.files.length}`);
  for (const file of plan.files) write(`  - ${file}`);
  const scopes = enabledScopes(plan.scope);
  write(`[verify-change] CI scope: ${scopes.length ? scopes.join(", ") : "none"}`);
  write(
    `[verify-change] Workspace selection: ${
      plan.scope.full || (plan.scope.quality && plan.workspaceNames.length === 0)
        ? "full monorepo"
        : plan.workspaceNames.length
          ? plan.workspaceNames.join(", ")
          : "none"
    }`,
  );
  write("[verify-change] Fast checks:");
  if (plan.fastSteps.length === 0) write("  - none");
  for (const current of plan.fastSteps) write(`  - ${current.id}: ${formatCommand(current.command, current.args)}`);
  write("[verify-change] Required follow-up checks:");
  if (plan.deferredGates.length === 0) write("  - none");
  for (const gate of plan.deferredGates) {
    write(`  - ${gate.id}: ${gate.command}`);
    write(`    ${gate.note}`);
  }
}

export function executeFastSteps(plan, { cwd = process.cwd(), run = spawnSync } = {}) {
  for (const current of plan.fastSteps) {
    console.log(`\n[verify-change] Running ${current.id}: ${formatCommand(current.command, current.args)}`);
    const result = run(current.command, current.args, { cwd, stdio: "inherit", shell: false });
    if (result.error) throw new Error(`${current.id} could not start: ${result.error.message}`);
    if (result.status !== 0) return { passed: false, failedStep: current.id, status: result.status ?? 1 };
  }
  return { passed: true };
}

export function verificationExitCode(plan, result) {
  if (!result.passed) return 1;
  if (plan.deferredGates.length > 0) return DEFERRED_GATES_EXIT_CODE;
  return 0;
}

export function parseArguments(argv) {
  const options = { base: "origin/main", planOnly: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--plan") options.planOnly = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--base") {
      const value = argv[index + 1];
      if (!value) throw new Error("--base requires a git ref");
      options.base = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  assertSafeRef(options.base);
  return options;
}

function printUsage() {
  console.log(`Usage: pnpm verify:change -- [--plan] [--base <ref>]

  --plan        Print the selected checks without running them
  --base <ref>  Compare against the merge base with this ref (default: origin/main)`);
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      printUsage();
      return 0;
    }
    const files = collectChangedFiles(options.base, { cwd });
    const workspaces = readWorkspaces({ cwd });
    const plan = createVerificationPlan(files, { workspaces, baseRef: options.base });
    printPlan(plan);
    if (options.planOnly) {
      console.log("[verify-change] PLAN ONLY — no checks were executed.");
      return 0;
    }

    const result = executeFastSteps(plan, { cwd });
    const exitCode = verificationExitCode(plan, result);
    if (exitCode === 1) {
      console.error(`[verify-change] FAILED — ${result.failedStep} exited with status ${result.status}.`);
      return 1;
    }
    if (exitCode === DEFERRED_GATES_EXIT_CODE) {
      console.error(
        `[verify-change] PARTIAL — fast checks passed, but ${plan.deferredGates.length} required follow-up check(s) remain.`,
      );
      return exitCode;
    }
    console.log("[verify-change] READY — every required local check passed.");
    return 0;
  } catch (error) {
    console.error(`[verify-change] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
