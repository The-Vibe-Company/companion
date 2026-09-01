import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testflightScope } from "./macos-testflight-scope.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_SCRIPT = resolve(ROOT, "apps/macos/scripts/release.sh");
const BUILD_NUMBER = "20260901210000";
const PRIVATE_KEY_FIXTURE = "fixture-private-key-content";

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFixture(cwd, path, contents, message) {
  const absolutePath = join(cwd, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  git(cwd, ["add", "--", path]);
  git(cwd, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function xcodebuildStub() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "call_kind=\"$1\"",
    "{",
    "  printf '%s' \"$call_kind\"",
    "  for argument in \"$@\"; do printf '\\t%s' \"$argument\"; done",
    "  printf '\\n'",
    "} >> \"$XCODEBUILD_CALLS\"",
    "key_path=''",
    "output_path=''",
    "previous=''",
    "for argument in \"$@\"; do",
    "  if [[ \"$previous\" == '-authenticationKeyPath' ]]; then key_path=\"$argument\"; fi",
    "  if [[ \"$previous\" == '-archivePath' || \"$previous\" == '-exportPath' ]]; then output_path=\"$argument\"; fi",
    "  previous=\"$argument\"",
    "done",
    "[[ -n \"$key_path\" && -r \"$key_path\" ]] || { echo 'missing API key' >&2; exit 70; }",
    "if [[ \"${STUB_XCODEBUILD_FAIL_ON:-}\" == \"$call_kind\" ]]; then echo \"stub $call_kind failure\" >&2; exit 71; fi",
    "mkdir -p \"$output_path\"",
    "echo \"stub $call_kind success\"",
    "",
  ].join("\n");
}

function runRelease(t, { failOn = "", prepare } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-macos-release-test-"));
  const binDir = join(fixtureRoot, "bin");
  const callsPath = join(fixtureRoot, "xcodebuild-calls.tsv");
  const outputDir = join(fixtureRoot, "release-output");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "xcodebuild"), xcodebuildStub());
  chmodSync(join(binDir, "xcodebuild"), 0o755);
  prepare?.({ outputDir });
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));

  const result = spawnSync("bash", [RELEASE_SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ASC_ISSUER_ID: "fixture-issuer",
      ASC_KEY_ID: "FIXTUREKEY",
      ASC_KEY_P8: PRIVATE_KEY_FIXTURE,
      BUILD_NUMBER,
      MACOS_PROVISIONING_PROFILE_SPECIFIER: "Fixture Mac App Store Profile",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      RELEASE_OUTPUT_DIR: outputDir,
      STUB_XCODEBUILD_FAIL_ON: failOn,
      TMPDIR: fixtureRoot,
      XCODEBUILD_CALLS: callsPath,
    },
  });
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("\t").slice(1))
    : [];
  const keyDirectories = readdirSync(fixtureRoot).filter((entry) => entry.startsWith("companion-asc-key."));
  return { calls, keyDirectories, outputDir, result };
}

test("the native macOS release archives then uploads with an ephemeral API key", (t) => {
  const { calls, keyDirectories, outputDir, result } = runRelease(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(([command]) => command), ["archive", "-exportArchive"]);
  assert.ok(calls[0].includes(`CURRENT_PROJECT_VERSION=${BUILD_NUMBER}`));
  assert.ok(calls[0].includes("PROVISIONING_PROFILE_SPECIFIER=Fixture Mac App Store Profile"));
  assert.ok(calls[1].includes(resolve(ROOT, "apps/macos/Config/ExportOptions.plist")));
  assert.equal(readFileSync(join(outputDir, "archive.log"), "utf8"), "stub archive success\n");
  assert.equal(readFileSync(join(outputDir, "export.log"), "utf8"), "stub -exportArchive success\n");
  assert.equal(statSync(join(outputDir, "archive.log")).mode & 0o044, 0o044);
  assert.equal(statSync(join(outputDir, "export.log")).mode & 0o044, 0o044);
  assert.deepEqual(keyDirectories, []);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${calls.flat().join(" ")}`, new RegExp(PRIVATE_KEY_FIXTURE));
});

test("the native macOS release stops before export after archive failure", (t) => {
  const { calls, keyDirectories, result } = runRelease(t, { failOn: "archive" });
  assert.equal(result.status, 71);
  assert.deepEqual(calls.map(([command]) => command), ["archive"]);
  assert.deepEqual(keyDirectories, []);
  assert.doesNotMatch(result.stdout, /Upload accepted/);
});

test("the native macOS release propagates export failure", (t) => {
  const { calls, keyDirectories, outputDir, result } = runRelease(t, { failOn: "-exportArchive" });
  assert.equal(result.status, 71);
  assert.deepEqual(calls.map(([command]) => command), ["archive", "-exportArchive"]);
  assert.match(readFileSync(join(outputDir, "export.log"), "utf8"), /stub -exportArchive failure/);
  assert.deepEqual(keyDirectories, []);
  assert.doesNotMatch(result.stdout, /Upload accepted/);
});

test("the native macOS release refuses to overwrite an existing numbered archive", (t) => {
  const { calls, result } = runRelease(t, {
    prepare: ({ outputDir }) => mkdirSync(join(outputDir, `CompanionMac-${BUILD_NUMBER}.xcarchive`), { recursive: true }),
  });
  assert.equal(result.status, 1);
  assert.deepEqual(calls, []);
  assert.match(result.stderr, /Release output already exists/);
});

test("TestFlight scope includes macOS changes from the complete approved push", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-macos-scope-test-"));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  git(fixtureRoot, ["init", "--quiet"]);
  commitFixture(fixtureRoot, "README.md", "fixture\n", "initial");
  const beforeSha = git(fixtureRoot, ["rev-parse", "HEAD"]);
  const macosSha = commitFixture(fixtureRoot, "apps/macos/Feature.swift", "struct Feature {}\n", "macOS change");
  const releaseSha = commitFixture(fixtureRoot, "docs/note.md", "follow-up\n", "non-macOS follow-up");
  assert.equal(testflightScope(beforeSha, releaseSha, { cwd: fixtureRoot }).macos, true);
  assert.equal(testflightScope(macosSha, releaseSha, { cwd: fixtureRoot }).macos, false);
});

test("TestFlight scope treats its release plumbing as a macOS change", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-macos-release-plumbing-test-"));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  git(fixtureRoot, ["init", "--quiet"]);
  commitFixture(fixtureRoot, "README.md", "fixture\n", "initial");
  const beforeSha = git(fixtureRoot, ["rev-parse", "HEAD"]);
  const releaseSha = commitFixture(
    fixtureRoot,
    ".github/workflows/macos-testflight.yml",
    "name: fixture\n",
    "macOS release plumbing",
  );
  assert.equal(testflightScope(beforeSha, releaseSha, { cwd: fixtureRoot }).macos, true);
});

test("the macOS TestFlight workflow releases only a CI-approved main commit", () => {
  const workflow = read(".github/workflows/macos-testflight.yml");
  const ciWorkflow = read(".github/workflows/ci.yml");
  const releaseScope = workflow.slice(workflow.indexOf("  release-scope:"), workflow.indexOf("  upload:"));

  assert.match(workflow, /^name: "Release: macOS TestFlight"$/m);
  assert.match(workflow, /^  workflow_run:$/m);
  assert.doesNotMatch(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  push:$/m);
  assert.match(releaseScope, /workflow_run\.conclusion == 'success'/);
  assert.match(releaseScope, /head_repository\.full_name == github\.repository/);
  assert.match(releaseScope, /name: macos-testflight-scope/);
  assert.match(releaseScope, /run: node scripts\/macos-testflight-scope\.mjs/);
  assert.doesNotMatch(releaseScope, /secrets\.|environment: macos-testflight/);
  assert.match(ciWorkflow, /name: macos-testflight-scope/);
  assert.match(workflow, /ref: \$\{\{ needs\.release-scope\.outputs\.release_sha \}\}/);
  assert.match(workflow, /^    environment: macos-testflight$/m);
  assert.match(workflow, /^  group: macos-testflight$/m);
  assert.match(workflow, /MACOS_DISTRIBUTION_P12: \$\{\{ secrets\.MACOS_DISTRIBUTION_P12 \}\}/);
  assert.match(workflow, /MACOS_INSTALLER_P12: \$\{\{ secrets\.MACOS_INSTALLER_P12 \}\}/);
  assert.match(workflow, /MACOS_PROVISIONING_PROFILE: \$\{\{ secrets\.MACOS_PROVISIONING_PROFILE \}\}/);
  assert.match(workflow, /-T \/usr\/bin\/productbuild -T \/usr\/bin\/productsign/);
  assert.match(workflow, /id: release/);
  assert.match(workflow, /if: always\(\) && steps\.release\.outcome != 'success'/);
  assert.match(workflow, /bash apps\/macos\/scripts\/release\.sh/);
  assert.doesNotMatch(workflow, /pull_request:/);
});

test("the macOS App Store export pins signing identities and profile", () => {
  const exportOptions = read("apps/macos/Config/ExportOptions.plist");
  assert.match(exportOptions, /<key>destination<\/key>\s*<string>upload<\/string>/);
  assert.match(exportOptions, /<key>signingCertificate<\/key>\s*<string>Apple Distribution<\/string>/);
  assert.match(exportOptions, /<key>installerSigningCertificate<\/key>\s*<string>3rd Party Mac Developer Installer<\/string>/);
  assert.match(exportOptions, /<key>dev\.companion\.mobile<\/key>/);
  assert.match(exportOptions, /Companion macOS App Store 2026-09-01/);
});
