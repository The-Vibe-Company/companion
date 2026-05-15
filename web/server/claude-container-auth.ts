import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

function hasAuthEnv(envVars?: Record<string, unknown>): boolean {
  return AUTH_ENV_KEYS.some((key) => typeof envVars?.[key] === "string" && (envVars[key] as string).trim().length > 0);
}

function hasClaudeSettingsAuthEnv(claudeDir: string): boolean {
  for (const filename of ["settings.json", "settings.local.json"]) {
    const path = join(claudeDir, filename);
    if (!existsSync(path)) continue;

    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { env?: Record<string, unknown> };
      if (hasAuthEnv(parsed.env)) return true;
    } catch {
      // Ignore malformed Claude settings here. The real CLI will surface its
      // own config error if the user launches a session with a bad file.
    }
  }
  return false;
}

/**
 * Returns true when Claude running inside a container has a plausible auth source:
 * - explicit auth env vars, or
 * - known auth files under ~/.claude that can be copied into the container, or
 * - user-level Claude settings env vars that make the local CLI usable.
 */
export function hasContainerClaudeAuth(envVars?: Record<string, string>): boolean {
  if (hasAuthEnv(envVars)) {
    return true;
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const claudeDir = join(home, ".claude");
  const candidates = [
    join(claudeDir, ".credentials.json"),
    join(claudeDir, "auth.json"),
    join(claudeDir, ".auth.json"),
    join(claudeDir, "credentials.json"),
  ];

  return candidates.some((p) => existsSync(p)) || hasClaudeSettingsAuthEnv(claudeDir);
}
