import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { classifyFiles } from "./ci-scope.mjs";
import {
  affectedWorkspaceNames,
  changedPathsFromNameStatus,
  collectChangedFiles,
  createVerificationPlan,
  executeFastSteps,
  parseArguments,
  verificationExitCode,
} from "./verify-change.mjs";

test("copy records can omit the untouched source for incremental file gates", () => {
  const copyRecord = Buffer.from("C100\0src/legacy.ts\0src/copied.ts\0");
  assert.deepEqual(changedPathsFromNameStatus(copyRecord), ["src/legacy.ts", "src/copied.ts"]);
  assert.deepEqual(changedPathsFromNameStatus(copyRecord, { includeCopySources: false }), ["src/copied.ts"]);
});

const workspaces = [
  { name: "@companion/api", path: "apps/api" },
  { name: "@companion/web", path: "apps/web" },
  { name: "@companion/runtime", path: "apps/runtime" },
  { name: "@companion/core", path: "packages/core" },
  { name: "@companion/db", path: "packages/db" },
];

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function removeTemporaryRepository(directory) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      lastError = error;
      await delay(50 * (attempt + 1));
    }
  }
  throw lastError;
}

function initRepository(context) {
  const directory = mkdtempSync(join(tmpdir(), "companion-verify-change-"));
  // Git can briefly recreate .git bookkeeping after a child process exits on macOS. Retry the
  // complete tree removal, not only one failing rmdir syscall, so a partial cleanup can converge.
  context.after(() => removeTemporaryRepository(directory));
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.email", "verify-change@example.invalid"]);
  git(directory, ["config", "user.name", "Verify change test"]);
  git(directory, ["config", "commit.gpgsign", "false"]);
  return directory;
}

function write(directory, relativePath, content = "fixture\n") {
  mkdirSync(join(directory, relativePath, ".."), { recursive: true });
  writeFileSync(join(directory, relativePath), content);
}

test("collects committed, staged, unstaged, deleted, renamed, and untracked files", (context) => {
  const directory = initRepository(context);
  for (const path of [
    "apps/api/src/committed.ts",
    "apps/api/src/deleted.ts",
    "apps/web/src/renamed-before.ts",
    "packages/core/src/staged.ts",
    "packages/db/src/unstaged.ts",
  ]) {
    write(directory, path, `${path}\n`);
  }
  git(directory, ["add", "."]);
  git(directory, ["commit", "--quiet", "-m", "fixture: base"]);
  const base = git(directory, ["rev-parse", "HEAD"]);

  write(directory, "apps/api/src/committed.ts", "committed change\n");
  git(directory, ["add", "apps/api/src/committed.ts"]);
  git(directory, ["commit", "--quiet", "-m", "fixture: branch commit"]);
  rmSync(join(directory, "apps/api/src/deleted.ts"));
  git(directory, ["add", "--update"]);
  renameSync(
    join(directory, "apps/web/src/renamed-before.ts"),
    join(directory, "apps/web/src/renamed-after.ts"),
  );
  git(directory, ["add", "apps/web/src/renamed-before.ts", "apps/web/src/renamed-after.ts"]);
  write(directory, "packages/core/src/staged.ts", "staged change\n");
  git(directory, ["add", "packages/core/src/staged.ts"]);
  write(directory, "packages/db/src/unstaged.ts", "unstaged change\n");
  write(directory, "apps/web/src/untracked.ts");

  assert.deepEqual(collectChangedFiles(base, { cwd: directory }), [
    "apps/api/src/committed.ts",
    "apps/api/src/deleted.ts",
    "apps/web/src/renamed-after.ts",
    "apps/web/src/renamed-before.ts",
    "apps/web/src/untracked.ts",
    "packages/core/src/staged.ts",
    "packages/db/src/unstaged.ts",
  ]);
});

test("returns no changes for a clean branch", (context) => {
  const directory = initRepository(context);
  write(directory, "README.md");
  git(directory, ["add", "."]);
  git(directory, ["commit", "--quiet", "-m", "fixture: base"]);
  const base = git(directory, ["rev-parse", "HEAD"]);
  assert.deepEqual(collectChangedFiles(base, { cwd: directory }), []);
});

test("includes tracked file type changes", (context) => {
  const directory = initRepository(context);
  write(directory, "packages/core/src/type-change.ts");
  git(directory, ["add", "."]);
  git(directory, ["commit", "--quiet", "-m", "fixture: base"]);
  const base = git(directory, ["rev-parse", "HEAD"]);
  rmSync(join(directory, "packages/core/src/type-change.ts"));
  symlinkSync("replacement.ts", join(directory, "packages/core/src/type-change.ts"));

  assert.deepEqual(collectChangedFiles(base, { cwd: directory }), ["packages/core/src/type-change.ts"]);
});

test("fails clearly when the worktree has unresolved conflicts", (context) => {
  const directory = initRepository(context);
  write(directory, "scripts/conflict.mjs", "export const value = 'base';\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "--quiet", "-m", "fixture: base"]);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const initialBranch = git(directory, ["branch", "--show-current"]);
  git(directory, ["checkout", "--quiet", "-b", "fixture-side"]);
  write(directory, "scripts/conflict.mjs", "export const value = 'side';\n");
  git(directory, ["commit", "--quiet", "-am", "fixture: side"]);
  git(directory, ["checkout", "--quiet", initialBranch]);
  write(directory, "scripts/conflict.mjs", "export const value = 'main';\n");
  git(directory, ["commit", "--quiet", "-am", "fixture: main"]);
  assert.throws(() => git(directory, ["merge", "--no-edit", "fixture-side"]));

  assert.throws(
    () => collectChangedFiles(base, { cwd: directory }),
    /unresolved merge conflicts: scripts\/conflict\.mjs/,
  );
});

test("reports a missing base ref explicitly", (context) => {
  const directory = initRepository(context);
  write(directory, "README.md");
  git(directory, ["add", "."]);
  git(directory, ["commit", "--quiet", "-m", "fixture: base"]);
  assert.throws(
    () => collectChangedFiles("origin/does-not-exist", { cwd: directory }),
    /base ref 'origin\/does-not-exist' does not resolve to a commit/,
  );
});

test("documentation-only changes do not schedule application checks", () => {
  const plan = createVerificationPlan(["README.md", "docs/testing.md"], { workspaces });
  assert.equal(plan.scope.docs, true);
  assert.deepEqual(plan.fastSteps.map(({ id }) => id), ["hygiene"]);
  assert.deepEqual(plan.deferredGates, []);
});

for (const conductorLauncherPath of [
  ".conductor/settings.toml",
  "scripts/setup-conductor.sh",
  "scripts/dev-environment.sh",
]) {
  test(`${conductorLauncherPath} schedules the native development stack check`, () => {
    const plan = createVerificationPlan([conductorLauncherPath], {
      workspaces,
    });
    assert.deepEqual(plan.fastSteps.map(({ id }) => id), ["hygiene", "dev-stack", "quality"]);
    const devStack = plan.fastSteps.find(({ id }) => id === "dev-stack");
    assert.deepEqual(devStack, {
      id: "dev-stack",
      command: "bash",
      args: ["scripts/dev-stack-check.sh"],
    });
  });
}

test("a web change selects the web workspace and browser validation", () => {
  const plan = createVerificationPlan(["apps/web/src/app/page.tsx"], {
    workspaces,
    env: { CONDUCTOR_PORT: "4310" },
  });
  assert.deepEqual(plan.workspaceNames, ["@companion/web"]);
  assert.deepEqual(plan.fastSteps.map(({ id }) => id), [
    "hygiene",
    "anti-slop-tests",
    "anti-slop",
    "quality",
    "build",
  ]);
  assert.deepEqual(plan.deferredGates.map(({ id }) => id), ["browser", "containers"]);
  assert.match(plan.deferredGates[0].command, /APP_URL=http:\/\/127\.0\.0\.1:4310/);
});

test("a core change selects its workspace and runs anti-slop against the requested base", () => {
  const plan = createVerificationPlan(["packages/core/src/services.ts"], {
    workspaces,
    baseRef: "upstream/trunk",
  });
  assert.deepEqual(plan.workspaceNames, ["@companion/core"]);
  assert.ok(plan.deferredGates.some(({ id }) => id === "database"));
  const antiSlop = plan.fastSteps.find(({ id }) => id === "anti-slop");
  assert.deepEqual(antiSlop, {
    id: "anti-slop",
    command: "pnpm",
    args: ["lint:anti-slop", "--", "--base", "upstream/trunk"],
  });
  const quality = plan.fastSteps.find(({ id }) => id === "quality");
  assert.deepEqual(quality.args.slice(-2), ["--filter", "...@companion/core"]);
  assert.ok(plan.fastSteps.indexOf(antiSlop) < plan.fastSteps.indexOf(quality));
});

test("a bundled-skill input change verifies the committed agent-client bundle", () => {
  const plan = createVerificationPlan(["packages/contracts/src/companions.ts"], { workspaces });
  assert.equal(plan.scope.skill, true);
  const ids = plan.fastSteps.map(({ id }) => id);
  assert.ok(ids.includes("skill-agent-client"));
  assert.ok(ids.indexOf("skill-agent-client") < ids.indexOf("skill-version"));
});

test("root configuration changes force the full monorepo and every CI lane", () => {
  const plan = createVerificationPlan(["package.json"], { workspaces });
  assert.equal(plan.scope.full, true);
  assert.deepEqual(plan.workspaceNames, []);
  const quality = plan.fastSteps.find(({ id }) => id === "quality");
  assert.equal(quality.args.includes("--filter"), false);
  assert.deepEqual(plan.deferredGates.map(({ id }) => id), [
    "database",
    "browser",
    "containers",
    "dependencies",
  ]);
});

test("an unmapped source change falls back to full quality checks", () => {
  const files = ["scripts/custom-runtime-check.mjs"];
  const scope = classifyFiles(files);
  assert.deepEqual(affectedWorkspaceNames(files, scope, workspaces), []);
  const plan = createVerificationPlan(files, { workspaces });
  const quality = plan.fastSteps.find(({ id }) => id === "quality");
  assert.equal(quality.args.includes("--filter"), false);
});

test("executes commands as argument arrays with shell disabled", () => {
  const calls = [];
  const plan = createVerificationPlan(["packages/core/test/authz.test.ts"], { workspaces });
  const result = executeFastSteps(plan, {
    cwd: "/fixture",
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { passed: true });
  assert.ok(calls.length > 0);
  assert.ok(calls.every(({ args, options }) => Array.isArray(args) && options.shell === false));
});

test("uses a distinct exit code while required follow-up gates remain", () => {
  const readyPlan = createVerificationPlan(["README.md"], { workspaces });
  const partialPlan = createVerificationPlan(["packages/core/src/services.ts"], { workspaces });
  assert.equal(verificationExitCode(readyPlan, { passed: true }), 0);
  assert.equal(verificationExitCode(partialPlan, { passed: true }), 2);
  assert.equal(verificationExitCode(readyPlan, { passed: false }), 1);
});

test("parses the public CLI options and rejects option-like refs", () => {
  assert.deepEqual(parseArguments([]), { base: "origin/main", planOnly: false, help: false });
  assert.deepEqual(parseArguments(["--", "--plan"]), {
    base: "origin/main",
    planOnly: true,
    help: false,
  });
  assert.deepEqual(parseArguments(["--plan", "--base", "upstream/trunk"]), {
    base: "upstream/trunk",
    planOnly: true,
    help: false,
  });
  assert.throws(() => parseArguments(["--base", "--upload-pack=bad"]), /invalid base ref/);
  assert.throws(() => parseArguments(["--unknown"]), /unknown argument/);
});
