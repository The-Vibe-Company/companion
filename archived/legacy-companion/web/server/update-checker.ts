import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings, type UpdateChannel } from "./settings-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read current version from package.json
const packageJsonPath = resolve(__dirname, "..", "package.json");
const currentVersion: string = JSON.parse(
  readFileSync(packageJsonPath, "utf-8"),
).version;

const NPM_REGISTRY_BASE = "https://registry.npmjs.org/the-companion";
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 10_000; // 10 seconds after boot

interface UpdateState {
  currentVersion: string;
  latestVersion: string | null;
  lastChecked: number;
  isServiceMode: boolean;
  checking: boolean;
  updateInProgress: boolean;
  channel: UpdateChannel;
}

const state: UpdateState = {
  currentVersion,
  latestVersion: null,
  lastChecked: 0,
  isServiceMode: false,
  checking: false,
  updateInProgress: false,
  channel: "stable",
};

export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

export function getCurrentVersion(): string {
  return currentVersion;
}

/** Returns the npm registry URL for the given dist-tag. */
function getRegistryUrl(channel: UpdateChannel): string {
  const distTag = channel === "prerelease" ? "next" : "latest";
  return `${NPM_REGISTRY_BASE}/${distTag}`;
}

export async function checkForUpdate(): Promise<void> {
  if (state.checking) return;
  state.checking = true;
  try {
    // Read channel from settings on each check so switching is immediate
    const channel = getSettings().updateChannel;
    if (channel !== state.channel) {
      state.latestVersion = null; // avoid cross-channel stale comparison
    }
    state.channel = channel;
    const url = getRegistryUrl(channel);

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { version: string };
      state.latestVersion = data.version;
      state.lastChecked = Date.now();
      if (isUpdateAvailable()) {
        console.log(
          `[update-checker] Update available (${channel}): ${currentVersion} -> ${state.latestVersion}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[update-checker] Failed to check for updates:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    state.checking = false;
  }
}

export function setServiceMode(isService: boolean): void {
  state.isServiceMode = isService;
}

export function setUpdateInProgress(inProgress: boolean): void {
  state.updateInProgress = inProgress;
}

export function isUpdateAvailable(): boolean {
  if (!state.latestVersion) return false;
  return isNewerVersion(state.latestVersion, currentVersion);
}

/**
 * Parse a semver string into its components.
 * Handles versions like "1.2.3", "1.2.3-preview.20260228120000.abc1234"
 */
function parseSemver(v: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const [corePart, ...prereleaseParts] = v.split("-");
  const prerelease = prereleaseParts.length > 0 ? prereleaseParts.join("-").split(".") : [];
  const parts = corePart.split(".").map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    prerelease,
  };
}

/**
 * Compare two semver prerelease identifier arrays.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 * A version with no prerelease identifiers has higher precedence than one with.
 */
function comparePrereleaseArrays(a: string[], b: string[]): number {
  // No prerelease on both = equal
  if (a.length === 0 && b.length === 0) return 0;
  // No prerelease > has prerelease (stable is newer than prerelease of same core version)
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    // Fewer fields = lower precedence
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;

    const aNum = Number(a[i]);
    const bNum = Number(b[i]);
    const aIsNum = !isNaN(aNum);
    const bIsNum = !isNaN(bNum);

    if (aIsNum && bIsNum) {
      if (aNum > bNum) return 1;
      if (aNum < bNum) return -1;
    } else if (aIsNum) {
      // Numeric identifiers have lower precedence than alphanumeric
      return -1;
    } else if (bIsNum) {
      return 1;
    } else {
      // Both alphanumeric: compare lexically
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
  }
  return 0;
}

/**
 * Prerelease-aware semver comparison: returns true if a > b.
 * Handles both stable versions (1.2.3) and prerelease versions
 * (1.2.3-preview.20260228120000.abc1234).
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  // Compare major.minor.patch
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;

  // Core versions are equal — compare prerelease
  return comparePrereleaseArrays(pa.prerelease, pb.prerelease) > 0;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCheck(): void {
  // Initial check after a short delay
  setTimeout(() => {
    checkForUpdate();
  }, INITIAL_DELAY_MS);

  // Periodic checks
  intervalId = setInterval(() => {
    checkForUpdate();
  }, CHECK_INTERVAL_MS);
}

export function stopPeriodicCheck(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
