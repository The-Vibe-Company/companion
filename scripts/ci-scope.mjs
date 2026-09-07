#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const OUTPUT_KEYS = [
  "docs",
  "design",
  "quality",
  "build",
  "database",
  "browser",
  "containers",
  "dependencies",
  "skill",
  "full",
];

function isDocumentation(file) {
  return (
    file === "DESIGN.md" ||
    file === "README.md" ||
    file === "CLAUDE.md" ||
    file === "AGENTS.md" ||
    file === "LICENSE" ||
    file === "SECURITY.md" ||
    file === "CONTRIBUTING.md" ||
    file.startsWith("docs/") ||
    file.endsWith(".md")
  );
}

function isTestFile(file) {
  return /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function matchesRuntimePackage(file) {
  return /^(apps|packages|cli)\//.test(file) && !isTestFile(file) && !/(^|\/)e2e\//.test(file);
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => (pattern instanceof RegExp ? pattern.test(file) : file.startsWith(pattern)));
}

export function classifyFiles(files, { forceFull = false } = {}) {
  const uniqueFiles = [...new Set(files.filter(Boolean))];
  const workflowOrRootConfig = uniqueFiles.some((file) =>
    matchesAny(file, [
      ".github/workflows/",
      /^package\.json$/,
      /^pnpm-lock\.yaml$/,
      /^pnpm-workspace\.yaml$/,
      /^turbo\.json$/,
      /^\.dockerignore$/,
      /^\.gitleaksignore$/,
      /^\.github\/dependabot\.yml$/,
      /^docker-compose\.yml$/,
      /^eslint\.config\.[^.]+$/,
      /^oxlint\.config\.[^.]+$/,
      /^tsconfig(?:\.[^.]+)?\.json$/,
      /^playwright\.config\.[cm]?[jt]s$/,
      /^scripts\/ci-scope(?:\.test)?\.mjs$/,
      /^scripts\/ci-playwright-policy(?:\.test)?\.mjs$/,
      /^scripts\/ci-gate(?:\.test)?\.mjs$/,
      /^scripts\/verify-change(?:\.test)?\.mjs$/,
    ]),
  );
  const full = forceFull || workflowOrRootConfig;
  const docs = forceFull || (uniqueFiles.length > 0 && uniqueFiles.every(isDocumentation));
  const design = full || uniqueFiles.includes("DESIGN.md") || uniqueFiles.includes(".github/workflows/design-md.yml");
  const dependencies = full || uniqueFiles.some((file) => file === "pnpm-lock.yaml" || /(^|\/)package\.json$/.test(file));
  // Any change under `skill/` counts, including SKILL.md, because the whole dir is integrity-tracked.
  // The committed `skill/scripts/companion-agent-client.mjs` bundle also inlines the companion-skill
  // client and `packages/contracts`, so editing those sources can invalidate the artifact and its
  // integrity baseline without touching `skill/` at all.
  const skill =
    full ||
    uniqueFiles.some(
      (file) =>
        file.startsWith("packages/companion-skill/skill/") ||
        (!isTestFile(file) &&
          !isDocumentation(file) &&
          matchesAny(file, ["packages/companion-skill/", "packages/contracts/"])),
    );
  const quality = full || uniqueFiles.some((file) => !isDocumentation(file));
  const build =
    full ||
    uniqueFiles.some(
      (file) =>
        !isDocumentation(file) &&
        (matchesRuntimePackage(file) ||
          file.startsWith("e2e/") ||
          matchesAny(file, ["scripts/ci-rsc-smoke.sh", "scripts/rsc-smoke.mjs"])),
    );
  const database =
    full ||
    uniqueFiles.some((file) =>
      !isDocumentation(file) &&
      (file.startsWith("apps/api/test/integration/") ||
        (!isTestFile(file) &&
          matchesAny(file, [
            "apps/api/",
            "apps/worker/",
            "packages/auth/",
            "packages/billing/",
            "packages/contracts/",
            "packages/core/",
            "packages/db/",
            "packages/email/",
            "packages/skills/",
            "packages/storage/",
            "scripts/ci-rsc-smoke.sh",
            "docker-compose.yml",
          ]))),
    );
  const browser =
    full ||
    uniqueFiles.some((file) =>
      !isDocumentation(file) &&
      (file.startsWith("e2e/") ||
        (!isTestFile(file) &&
          matchesAny(file, [
            "apps/web/",
            "apps/api/",
            "packages/auth/",
            "packages/contracts/",
            "packages/core/",
            "packages/companion-skill/",
            "packages/db/",
            "packages/email/",
            "packages/skills/",
            "packages/storage/",
            "scripts/ci-rsc-smoke.sh",
            "scripts/rsc-smoke.mjs",
            "scripts/agent-browser-smoke.sh",
            "scripts/agent-browser-box-center.mjs",
            "playwright.config.",
            "docker-compose.yml",
          ]))),
    );
  const containers =
    full ||
    uniqueFiles.some(
      (file) =>
        !isDocumentation(file) &&
        (matchesRuntimePackage(file) ||
          matchesAny(file, [
            "deploy/railway/",
            "scripts/ci-container-smoke.sh",
            "docker-compose.yml",
            ".dockerignore",
            "tsconfig.base.json",
          ])),
    );

  return { docs, design, quality, build, database, browser, containers, dependencies, skill, full };
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${key ?? "(end)"}`);
    values.set(key.slice(2), value);
  }
  return values;
}

export function changedFiles(base, head, { cwd } = {}) {
  if (!base || !head) throw new Error("pull_request scope requires --base and --head");
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRD", base, head, "--"], {
    cwd,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function writeOutputs(result, outputPath) {
  const lines = OUTPUT_KEYS.map((key) => `${key}=${result[key] ? "true" : "false"}`).join("\n") + "\n";
  if (outputPath) appendFileSync(outputPath, lines);
  process.stdout.write(lines);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = readArguments(process.argv.slice(2));
    const event = args.get("event") ?? "pull_request";
    const forceFull = event !== "pull_request";
    const files = forceFull ? [] : changedFiles(args.get("base"), args.get("head"));
    writeOutputs(classifyFiles(files, { forceFull }), args.get("github-output"));
  } catch (error) {
    console.error(`[ci-scope] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
