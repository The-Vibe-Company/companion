import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTeamForCliSession, listTargetableMembers } from "./team-config-reader.js";

let teamsDir: string;

beforeEach(() => {
  teamsDir = mkdtempSync(join(tmpdir(), "team-config-test-"));
});

afterEach(() => {
  rmSync(teamsDir, { recursive: true, force: true });
});

function writeTeam(name: string, body: Record<string, unknown>): void {
  const dir = join(teamsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(body));
}

describe("findTeamForCliSession", () => {
  // The headline use case: lookup a team by lead session id and get back
  // the parsed config with role inference applied.
  it("matches by leadSessionId and parses members with derived roles", () => {
    writeTeam("phase-x", {
      name: "phase-x",
      leadSessionId: "lead-123",
      leadAgentId: "team-lead@phase-x",
      members: [
        { name: "team-lead", agentId: "team-lead@phase-x", agentType: "team-lead", tmuxPaneId: "%1" },
        { name: "fuzzer", agentId: "fuzzer@phase-x", agentType: "fuzzer", backendType: "in-process" },
        { name: "reviewer", agentId: "reviewer@phase-x", agentType: "reviewer", backendType: "external" },
      ],
    });

    const team = findTeamForCliSession("lead-123", { teamsDir });
    expect(team).not.toBeNull();
    expect(team!.name).toBe("phase-x");
    expect(team!.members).toHaveLength(3);

    const byName = Object.fromEntries(team!.members.map((m) => [m.name, m]));
    expect(byName["team-lead"].role).toBe("lead");
    expect(byName["team-lead"].isLead).toBe(true);
    expect(byName["fuzzer"].role).toBe("transient");        // in-process
    expect(byName["fuzzer"].backendType).toBe("in-process");
    expect(byName["reviewer"].role).toBe("persistent");      // non-in-process
    expect(byName["reviewer"].backendType).toBe("external");
  });

  // Missing teams dir is the most common case (most users don't use agent
  // teams). Must not throw — return null silently.
  it("returns null when teams dir doesn't exist", () => {
    expect(findTeamForCliSession("any", { teamsDir: "/nonexistent/path" })).toBeNull();
  });

  // No matching team: also null. The cliSessionId is for a regular session
  // that isn't a team lead.
  it("returns null when no team has matching leadSessionId", () => {
    writeTeam("other-team", {
      name: "other-team",
      leadSessionId: "different-lead",
      leadAgentId: "team-lead@other-team",
      members: [{ name: "team-lead", agentId: "team-lead@other-team", agentType: "team-lead" }],
    });
    expect(findTeamForCliSession("not-the-lead", { teamsDir })).toBeNull();
  });

  // Multiple teams: pick the right one by leadSessionId, ignore the others.
  // Robust to several teams existing simultaneously (different sessions).
  it("returns the correct team when multiple teams exist", () => {
    writeTeam("team-a", {
      name: "team-a",
      leadSessionId: "lead-a",
      leadAgentId: "team-lead@team-a",
      members: [{ name: "team-lead", agentId: "team-lead@team-a", agentType: "team-lead" }],
    });
    writeTeam("team-b", {
      name: "team-b",
      leadSessionId: "lead-b",
      leadAgentId: "team-lead@team-b",
      members: [{ name: "team-lead", agentId: "team-lead@team-b", agentType: "team-lead" }],
    });
    expect(findTeamForCliSession("lead-a", { teamsDir })?.name).toBe("team-a");
    expect(findTeamForCliSession("lead-b", { teamsDir })?.name).toBe("team-b");
  });

  // Defensive: malformed config files must not crash. Skip and continue.
  it("skips malformed config files (invalid JSON, missing fields)", () => {
    // Create a malformed team
    const badDir = join(teamsDir, "bad-team");
    mkdirSync(badDir);
    writeFileSync(join(badDir, "config.json"), "{not valid json");

    // And a missing-fields team
    writeTeam("incomplete-team", { name: "incomplete-team" });

    // Add the team we actually want
    writeTeam("good-team", {
      name: "good-team",
      leadSessionId: "lead-123",
      leadAgentId: "team-lead@good-team",
      members: [{ name: "team-lead", agentId: "team-lead@good-team", agentType: "team-lead" }],
    });

    const team = findTeamForCliSession("lead-123", { teamsDir });
    expect(team).not.toBeNull();
    expect(team!.name).toBe("good-team");
  });

  // Empty cliSessionId: defensive null. Don't accidentally match the
  // first team with empty leadSessionId in some malformed config.
  it("returns null for empty cliSessionId", () => {
    writeTeam("phase", {
      name: "phase",
      leadSessionId: "real-lead",
      leadAgentId: "team-lead@phase",
      members: [{ name: "team-lead", agentId: "team-lead@phase", agentType: "team-lead" }],
    });
    expect(findTeamForCliSession("", { teamsDir })).toBeNull();
  });

  // Config that has a leadAgentId not present in members is internally
  // inconsistent — skip rather than return a "headless" team.
  it("skips config where leadAgentId isn't in members", () => {
    writeTeam("phase", {
      name: "phase",
      leadSessionId: "lead-x",
      leadAgentId: "team-lead@phase",
      members: [
        // No member with this agentId
        { name: "fuzzer", agentId: "fuzzer@phase", agentType: "fuzzer" },
      ],
    });
    expect(findTeamForCliSession("lead-x", { teamsDir })).toBeNull();
  });

  // Config with empty members: can't form a meaningful team, skip.
  it("skips config with no members", () => {
    writeTeam("phase", {
      name: "phase",
      leadSessionId: "lead-x",
      leadAgentId: "team-lead@phase",
      members: [],
    });
    expect(findTeamForCliSession("lead-x", { teamsDir })).toBeNull();
  });
});

describe("listTargetableMembers", () => {
  // Excludes transient (in-process) members because they're not
  // @-targetable. Includes the lead (caller is responsible for
  // additionally filtering out the lead if @-target shouldn't include
  // self). Includes any persistent (external) members.
  it("excludes transient members; keeps lead + persistent", () => {
    writeTeam("phase", {
      name: "phase",
      leadSessionId: "lead-x",
      leadAgentId: "team-lead@phase",
      members: [
        { name: "team-lead", agentId: "team-lead@phase", agentType: "team-lead" },
        { name: "in-proc", agentId: "in-proc@phase", agentType: "fuzzer", backendType: "in-process" },
        { name: "external", agentId: "external@phase", agentType: "reviewer", backendType: "external-process" },
      ],
    });
    const team = findTeamForCliSession("lead-x", { teamsDir })!;
    const targetable = listTargetableMembers(team).map((m) => m.name).sort();
    expect(targetable).toEqual(["external", "team-lead"]);
  });
});
