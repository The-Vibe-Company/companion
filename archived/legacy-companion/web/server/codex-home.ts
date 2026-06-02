import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { COMPANION_HOME } from "./paths.js";

export const DEFAULT_COMPANION_CODEX_HOME = join(
  COMPANION_HOME,
  "codex-home",
);

export function getLegacyCodexHome(): string {
  return join(homedir(), ".codex");
}

export function resolveCompanionCodexHome(explicitCodexHome?: string): string {
  // Intentionally do NOT fall back to process.env.CODEX_HOME here.
  // That env var points to the user's global Codex home (~/.codex), which
  // would break per-session isolation by nesting session dirs inside it.
  return resolve(explicitCodexHome || DEFAULT_COMPANION_CODEX_HOME);
}

export function resolveCompanionCodexSessionHome(
  sessionId: string,
  explicitCodexHome?: string,
): string {
  return join(resolveCompanionCodexHome(explicitCodexHome), sessionId);
}
