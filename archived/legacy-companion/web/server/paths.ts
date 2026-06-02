import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Base directory for all Companion configuration and state.
 * Defaults to ~/.companion/ for self-hosted installs.
 * Override with COMPANION_HOME env var for managed deployments
 * (e.g. COMPANION_HOME=/data/companion on Fly.io volumes).
 */
export const COMPANION_HOME =
  process.env.COMPANION_HOME || join(homedir(), ".companion");
