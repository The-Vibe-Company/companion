import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const localDatabase = "postgres://runtime@127.0.0.1:5432/disposable";

for (const credential of [
  "COMPANION_BOX_API_KEY",
  "OPENAI_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "COMPANION_MCP_GITHUB_CLIENT_SECRET",
]) {
  test(`the disposable rehearsal refuses ${credential}`, () => {
    const result = spawnSync(process.execPath, ["scripts/runtime-v3-cutover-rehearsal.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: localDatabase,
        DATABASE_MIGRATION_URL: localDatabase,
        DATABASE_API_URL: localDatabase,
        DATABASE_WORKER_URL: localDatabase,
        DATABASE_COMPANION_RUNTIME_URL: localDatabase,
        [credential]: "must-not-appear",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`refuses provider credentials: ${credential}`));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /must-not-appear/);
  });
}
