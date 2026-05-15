// Reads Claude Code's agent-team configuration from disk and matches it to
// a companion session via leadSessionId == cliSessionId.
//
// Why: companion sessions don't carry team membership in their own state.
// The authoritative source is Claude Code's per-team config files at
// ~/.claude/teams/<team-name>/config.json. The session's cliSessionId
// (the CLI's internal --resume identifier) is what the team config
// references as `leadSessionId`.
//
// Without reading this, message-history-based extraction can't tell apart
// in-process single-task subagents (transient) from persistent leads.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_TEAMS_DIR = join(homedir(), ".claude", "teams");

/** A team member as defined in config.json. The `state` field is derived,
 *  not from the file — based on backendType + lead status. */
export interface TeamMember {
  name: string;
  agentId: string;
  /** subagent_type in claude-code's terminology — also used as the agent
   *  identity in SendMessage targeting. */
  agentType: string;
  /** "in-process" means single-task subagent loop within the lead session.
   *  Absence (the lead member typically has no backendType) means external
   *  / persistent process. */
  backendType?: string;
  /** True for the team-lead role — the user's own conversational entity. */
  isLead: boolean;
  /** Derived role. Used by UI to decide whether to show this member as a
   *  targetable agent. */
  role: "lead" | "transient" | "persistent";
  /** Color from team config (UI hint). */
  color?: string;
}

export interface TeamInfo {
  /** Team name (directory name under ~/.claude/teams). */
  name: string;
  /** CLI session ID of the lead. Matches the companion session's
   *  cliSessionId field. */
  leadSessionId: string;
  /** Lead agent ID, e.g. "team-lead@va-phase35". */
  leadAgentId: string;
  members: TeamMember[];
  /** Path to the team's config.json (useful for debugging). */
  configPath: string;
}

interface TeamConfigOnDisk {
  name?: unknown;
  leadSessionId?: unknown;
  leadAgentId?: unknown;
  members?: unknown;
}

interface RawMember {
  name?: unknown;
  agentId?: unknown;
  agentType?: unknown;
  backendType?: unknown;
  color?: unknown;
}

/**
 * Find the team configuration that has the given cliSessionId as its lead.
 * Returns null if no matching team is found, the teams dir doesn't exist,
 * or the file is malformed.
 *
 * Reads on every call — team membership changes without restarting the
 * companion server, and we want the latest snapshot. The file is small and
 * the directory typically has a handful of entries, so this is cheap.
 */
export function findTeamForCliSession(
  cliSessionId: string,
  options: { teamsDir?: string } = {},
): TeamInfo | null {
  if (!cliSessionId) return null;
  const teamsDir = options.teamsDir ?? DEFAULT_TEAMS_DIR;
  if (!existsSync(teamsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(teamsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const teamDir = join(teamsDir, entry);
    let stat;
    try { stat = statSync(teamDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const configPath = join(teamDir, "config.json");
    if (!existsSync(configPath)) continue;

    let parsed: TeamConfigOnDisk;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8")) as TeamConfigOnDisk;
    } catch {
      continue;
    }

    if (typeof parsed.leadSessionId !== "string" || parsed.leadSessionId !== cliSessionId) {
      continue;
    }

    const team = parseTeamConfig(parsed, configPath);
    if (team) return team;
  }
  return null;
}

/** Parse and validate the on-disk config into a TeamInfo. Returns null on
 *  unfixable shape problems. */
function parseTeamConfig(parsed: TeamConfigOnDisk, configPath: string): TeamInfo | null {
  if (typeof parsed.name !== "string") return null;
  if (typeof parsed.leadSessionId !== "string") return null;
  if (typeof parsed.leadAgentId !== "string") return null;
  if (!Array.isArray(parsed.members)) return null;

  const leadAgentId = parsed.leadAgentId;
  const members: TeamMember[] = [];

  for (const raw of parsed.members) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as RawMember;
    if (typeof m.name !== "string" || m.name.length === 0) continue;
    if (typeof m.agentId !== "string") continue;
    if (typeof m.agentType !== "string") continue;

    const backendType = typeof m.backendType === "string" ? m.backendType : undefined;
    const isLead = m.agentId === leadAgentId;
    const role: TeamMember["role"] = isLead
      ? "lead"
      : backendType === "in-process"
        ? "transient"
        : "persistent";

    members.push({
      name: m.name,
      agentId: m.agentId,
      agentType: m.agentType,
      backendType,
      isLead,
      role,
      color: typeof m.color === "string" ? m.color : undefined,
    });
  }

  if (members.length === 0) return null;
  if (!members.some((m) => m.isLead)) {
    // No lead found in members — config is internally inconsistent. Bail.
    return null;
  }

  return {
    name: parsed.name,
    leadSessionId: parsed.leadSessionId,
    leadAgentId,
    members,
    configPath,
  };
}

/** Convenience: list members the user can meaningfully @-target. Excludes
 *  transient (in-process) agents — they're single-task subagents that
 *  don't accept directed messages in any sane way. Includes the lead and
 *  any persistent (non-in-process) members. */
export function listTargetableMembers(team: TeamInfo): TeamMember[] {
  return team.members.filter((m) => m.role !== "transient");
}
