#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function assertSha(name, value, { allowZero = false } = {}) {
  const valid = /^[0-9a-f]{40}$/.test(value);
  if (!valid || (!allowZero && /^0+$/.test(value))) throw new Error(`${name} is not a valid Git SHA`);
}

function gitChangedFiles(beforeSha, releaseSha, { cwd = process.cwd(), exec = execFileSync } = {}) {
  const args = /^0+$/.test(beforeSha)
    ? ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", releaseSha, "--"]
    : ["diff", "--name-only", beforeSha, releaseSha, "--"];
  return exec("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n")
    .filter(Boolean);
}

export function testflightScope(beforeSha, releaseSha, options) {
  assertSha("before SHA", beforeSha, { allowZero: true });
  assertSha("release SHA", releaseSha);
  const changedFiles = gitChangedFiles(beforeSha, releaseSha, options);
  return { changedFiles, macos: changedFiles.some((path) => path.startsWith("apps/macos/")), releaseSha };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main() {
  const beforeSha = readFileSync(requiredEnv("TESTFLIGHT_BEFORE_SHA_FILE"), "utf8").trim();
  const approvedReleaseSha = readFileSync(requiredEnv("TESTFLIGHT_RELEASE_SHA_FILE"), "utf8").trim();
  const releaseSha = requiredEnv("RELEASE_SHA");
  if (approvedReleaseSha !== releaseSha) throw new Error("CI artifact does not match the triggering workflow SHA");

  const scope = testflightScope(beforeSha, releaseSha);
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `macos=${scope.macos}\nrelease_sha=${scope.releaseSha}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
