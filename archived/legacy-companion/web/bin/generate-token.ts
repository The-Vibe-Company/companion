#!/usr/bin/env bun
/**
 * Generate (or regenerate) the Companion auth token.
 *
 * Usage:
 *   bun run generate-token          # show current or auto-generated token
 *   bun run generate-token --force  # force-regenerate a new token
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUTH_FILE = join(homedir(), ".companion", "auth.json");
const force = process.argv.includes("--force");

if (force && existsSync(AUTH_FILE)) {
  rmSync(AUTH_FILE);
}

// Import after potential delete so getToken() generates fresh
const { getToken } = await import("../server/auth-manager.ts");

const token = getToken();
const isNew = force ? "New" : existsSync(AUTH_FILE) ? "Current" : "Generated";

console.log(`\n  ${isNew} auth token: ${token}\n`);
console.log(`  Stored at: ${AUTH_FILE}`);
console.log(`  Tip: pass --force to regenerate\n`);
