import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Base directory for all AgentHangar configuration and state.
 * Defaults to ~/.agenthangar/ for self-hosted installs.
 * Override with AGENTHANGAR_HOME env var for managed deployments
 * (e.g. AGENTHANGAR_HOME=/data/agenthangar on Fly.io volumes).
 */
export const AGENTHANGAR_HOME =
  process.env.AGENTHANGAR_HOME || join(homedir(), ".agenthangar");
