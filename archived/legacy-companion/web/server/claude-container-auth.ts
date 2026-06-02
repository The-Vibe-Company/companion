import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns true when Claude running inside a container has a plausible auth source:
 * - explicit auth env vars, or
 * - known auth files under ~/.claude that can be copied into the container.
 */
export function hasContainerClaudeAuth(envVars?: Record<string, string>): boolean {
  if (
    !!envVars?.ANTHROPIC_API_KEY
    || !!envVars?.ANTHROPIC_AUTH_TOKEN
    || !!envVars?.CLAUDE_CODE_AUTH_TOKEN
    || !!envVars?.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    return true;
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const candidates = [
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude", "auth.json"),
    join(home, ".claude", ".auth.json"),
    join(home, ".claude", "credentials.json"),
  ];

  return candidates.some((p) => existsSync(p));
}

