import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// In-memory cache (60s TTL)
const CACHE_DURATION_MS = 60 * 1000;
let cache: { data: UsageLimits; timestamp: number } | null = null;

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [key: string]: unknown;
}

interface RawCredentials {
  raw: string;
  parsed: Record<string, unknown>;
  oauth: OAuthCredentials;
  sourcePath?: string;
}

// Credential file candidates - matches claude-container-auth.ts
const CREDENTIAL_FILE_NAMES = [
  ".credentials.json",
  "auth.json",
  ".auth.json",
  "credentials.json",
];

function readCredentialsFromFile(): RawCredentials | null {
  const home =
    process.env.USERPROFILE || process.env.HOME || homedir() || "";
  const claudeDir = join(home, ".claude");

  for (const fileName of CREDENTIAL_FILE_NAMES) {
    const credPath = join(claudeDir, fileName);
    if (!existsSync(credPath)) continue;
    try {
      const raw = readFileSync(credPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed?.claudeAiOauth?.accessToken) continue;
      return { raw, parsed, oauth: parsed.claudeAiOauth, sourcePath: credPath };
    } catch {
      continue;
    }
  }
  return null;
}

function readRawCredentials(): RawCredentials | null {
  try {
    // macOS: use Keychain via security command
    if (process.platform === "darwin") {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();

      const decoded = raw.startsWith("{")
        ? raw
        : Buffer.from(raw, "hex").toString("utf-8");

      const parsed = JSON.parse(decoded);
      if (!parsed?.claudeAiOauth?.accessToken) return null;
      return { raw: decoded, parsed, oauth: parsed.claudeAiOauth };
    }

    // Windows, Linux, Docker, and other platforms: read from credential files
    return readCredentialsFromFile();
  } catch {
    return null;
  }
}

function writeCredentials(creds: Record<string, unknown>, sourcePath?: string): void {
  try {
    const json = JSON.stringify(creds);
    if (process.platform === "darwin") {
      execFileSync(
        "security",
        ["add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", "Claude Code", "-w", json],
        { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      );
    } else {
      // Write back to the same file that was read, or default to .credentials.json
      const credPath = sourcePath ?? join(
        process.env.USERPROFILE || process.env.HOME || homedir() || "",
        ".claude",
        ".credentials.json",
      );
      writeFileSync(credPath, json, "utf-8");
    }
  } catch {
    // best-effort
  }
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  } catch {
    return null;
  }
}

export function getCredentials(): string | null {
  const creds = readRawCredentials();
  return creds?.oauth.accessToken ?? null;
}

async function getValidAccessToken(): Promise<string | null> {
  const creds = readRawCredentials();
  if (!creds) return null;

  const { oauth } = creds;

  // Token still valid (with 5min buffer)
  if (oauth.expiresAt && Date.now() < oauth.expiresAt - 5 * 60 * 1000) {
    return oauth.accessToken;
  }

  // Token expired - try to refresh
  if (!oauth.refreshToken) return null;

  const refreshed = await refreshAccessToken(oauth.refreshToken);
  if (!refreshed) return null;

  // Update stored credentials
  creds.parsed.claudeAiOauth = {
    ...oauth,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: Date.now() + refreshed.expiresIn * 1000,
  };
  writeCredentials(creds.parsed, creds.sourcePath);

  return refreshed.accessToken;
}

export async function fetchUsageLimits(
  token: string,
): Promise<UsageLimits | null> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/2.1.39",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      five_hour: data.five_hour || null,
      seven_day: data.seven_day || null,
      extra_usage: data.extra_usage || null,
    };
  } catch {
    return null;
  }
}

export async function getUsageLimits(): Promise<UsageLimits> {
  const empty: UsageLimits = {
    five_hour: null,
    seven_day: null,
    extra_usage: null,
  };
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_DURATION_MS) {
      return cache.data;
    }

    const token = await getValidAccessToken();
    if (!token) return empty;

    const limits = await fetchUsageLimits(token);
    if (!limits) return empty;

    cache = { data: limits, timestamp: Date.now() };
    return limits;
  } catch {
    return empty;
  }
}
