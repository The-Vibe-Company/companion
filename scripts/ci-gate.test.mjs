import assert from "node:assert/strict";
import test from "node:test";
import { rejectedJobs } from "./ci-gate.mjs";

const scopeOutputs = {
  quality: "false",
  build: "false",
  database: "false",
  browser: "false",
  containers: "false",
  dependencies: "false",
  skill: "false",
};

function jobs(overrides = {}, outputs = scopeOutputs) {
  return {
    scope: { result: "success", outputs },
    hygiene: { result: "success" },
    "apple-quality": { result: "skipped" },
    quality: { result: "skipped" },
    "application-build": { result: "skipped" },
    "database-integration": { result: "skipped" },
    "railway-containers": { result: "skipped" },
    browser: { result: "skipped" },
    ...overrides,
  };
}

test("accepts skips explicitly disabled by pull-request scope", () => {
  assert.deepEqual(rejectedJobs(jobs()), []);
});

test("rejects a skipped job required by scope", () => {
  const outputs = { ...scopeOutputs, browser: "true", build: "true" };
  const failures = rejectedJobs(jobs({ "application-build": { result: "success" } }, outputs));
  assert.deepEqual(failures, ["browser=skipped (required success)"]);
});

test("rejects missing scope outputs instead of treating them as false", () => {
  const { browser: _browser, ...outputs } = scopeOutputs;
  assert.deepEqual(rejectedJobs(jobs({}, outputs)), [
    "scope.browser=missing (required boolean output)",
  ]);
});

test("rejects failed, cancelled, and missing jobs even when scope disables them", () => {
  const failures = rejectedJobs(jobs({
    quality: { result: "failure" },
    "application-build": { result: "cancelled" },
    "database-integration": undefined,
  }));
  assert.deepEqual(failures, [
    "quality=failure (expected success or intentional skip)",
    "application-build=cancelled (expected success or intentional skip)",
    "database-integration=missing (expected success or intentional skip)",
  ]);
});
