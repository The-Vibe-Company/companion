import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns true when Codex running inside a container has a plausible auth source:
 * - explicit OpenAI auth env vars, or
 * - known auth files under ~/.codex that can be copied into the container.
 */
export function hasContainerCodexAuth(envVars?: Record<string, string>): boolean {
  if (
    !!envVars?.OPENAI_API_KEY
    || !!envVars?.CODEX_API_KEY
  ) {
    return true;
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const candidates = [
    join(home, ".codex", "auth.json"),
  ];

  return candidates.some((p) => existsSync(p));
}
