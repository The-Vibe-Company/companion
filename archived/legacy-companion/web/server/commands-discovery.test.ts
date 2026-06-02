import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let discoverFn: typeof import("./commands-discovery.js").discoverCommandsAndSkills;

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cmd-discovery-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  const mod = await import("./commands-discovery.js");
  discoverFn = mod.discoverCommandsAndSkills;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Helper to create directory structure ──────────────────────────────────────

function mkdirp(path: string) {
  mkdirSync(path, { recursive: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("discoverCommandsAndSkills", () => {
  it("returns empty arrays when no directories exist", async () => {
    // When there are no .claude directories at all, the function should
    // return empty arrays without throwing.
    const result = await discoverFn("/nonexistent/path");
    expect(result.slash_commands).toEqual([]);
    expect(result.skills).toEqual([]);
  });

  it("discovers user-level commands from ~/.claude/commands/*.md", async () => {
    // User commands are .md files in ~/.claude/commands/
    const cmdDir = join(tempDir, ".claude", "commands");
    mkdirp(cmdDir);
    writeFileSync(join(cmdDir, "commit.md"), "# Commit command");
    writeFileSync(join(cmdDir, "review-pr.md"), "# Review PR command");
    // Non-md files should be ignored
    writeFileSync(join(cmdDir, "notes.txt"), "not a command");

    const result = await discoverFn();
    expect(result.slash_commands).toEqual(["commit", "review-pr"]);
  });

  it("discovers project-level commands from {cwd}/.claude/commands/*.md", async () => {
    // Project commands are .md files in {cwd}/.claude/commands/
    const projectDir = join(tempDir, "my-project");
    const cmdDir = join(projectDir, ".claude", "commands");
    mkdirp(cmdDir);
    writeFileSync(join(cmdDir, "deploy.md"), "# Deploy command");

    const result = await discoverFn(projectDir);
    expect(result.slash_commands).toContain("deploy");
  });

  it("deduplicates commands between user and project level", async () => {
    // If the same command name exists at both user and project level,
    // it should appear only once in the result.
    const userCmdDir = join(tempDir, ".claude", "commands");
    mkdirp(userCmdDir);
    writeFileSync(join(userCmdDir, "commit.md"), "# User commit");

    const projectDir = join(tempDir, "my-project");
    const projectCmdDir = join(projectDir, ".claude", "commands");
    mkdirp(projectCmdDir);
    writeFileSync(join(projectCmdDir, "commit.md"), "# Project commit");
    writeFileSync(join(projectCmdDir, "test.md"), "# Test command");

    const result = await discoverFn(projectDir);
    // "commit" should appear only once, "test" should also appear
    expect(result.slash_commands).toEqual(["commit", "test"]);
  });

  it("returns sorted command names", async () => {
    // Commands should be sorted alphabetically regardless of filesystem order.
    const cmdDir = join(tempDir, ".claude", "commands");
    mkdirp(cmdDir);
    writeFileSync(join(cmdDir, "zebra.md"), "");
    writeFileSync(join(cmdDir, "alpha.md"), "");
    writeFileSync(join(cmdDir, "middle.md"), "");

    const result = await discoverFn();
    expect(result.slash_commands).toEqual(["alpha", "middle", "zebra"]);
  });

  it("discovers skills from ~/.claude/skills/*/SKILL.md", async () => {
    // Skills are identified by directories under ~/.claude/skills/ that
    // contain a SKILL.md file. The directory name is used as the slug.
    const skillsDir = join(tempDir, ".claude", "skills");
    mkdirp(join(skillsDir, "my-skill"));
    writeFileSync(join(skillsDir, "my-skill", "SKILL.md"), "---\nname: My Skill\n---\n# Skill");
    mkdirp(join(skillsDir, "another-skill"));
    writeFileSync(join(skillsDir, "another-skill", "SKILL.md"), "# Another");

    const result = await discoverFn();
    expect(result.skills).toEqual(["another-skill", "my-skill"]);
  });

  it("ignores skill directories without SKILL.md", async () => {
    // A directory under ~/.claude/skills/ without a SKILL.md should be ignored.
    const skillsDir = join(tempDir, ".claude", "skills");
    mkdirp(join(skillsDir, "valid-skill"));
    writeFileSync(join(skillsDir, "valid-skill", "SKILL.md"), "# Valid");
    mkdirp(join(skillsDir, "incomplete-skill"));
    // No SKILL.md in incomplete-skill

    const result = await discoverFn();
    expect(result.skills).toEqual(["valid-skill"]);
  });

  it("returns sorted skill names", async () => {
    // Skills should be sorted alphabetically by directory name.
    const skillsDir = join(tempDir, ".claude", "skills");
    mkdirp(join(skillsDir, "zulu"));
    writeFileSync(join(skillsDir, "zulu", "SKILL.md"), "");
    mkdirp(join(skillsDir, "alpha"));
    writeFileSync(join(skillsDir, "alpha", "SKILL.md"), "");

    const result = await discoverFn();
    expect(result.skills).toEqual(["alpha", "zulu"]);
  });

  it("handles cwd being undefined", async () => {
    // When no cwd is provided, only user-level items should be discovered.
    const cmdDir = join(tempDir, ".claude", "commands");
    mkdirp(cmdDir);
    writeFileSync(join(cmdDir, "global-cmd.md"), "");

    const result = await discoverFn(undefined);
    expect(result.slash_commands).toEqual(["global-cmd"]);
  });

  it("ignores non-file entries in commands directory", async () => {
    // Subdirectories inside commands/ should be ignored.
    const cmdDir = join(tempDir, ".claude", "commands");
    mkdirp(cmdDir);
    writeFileSync(join(cmdDir, "valid.md"), "");
    mkdirp(join(cmdDir, "subdirectory.md")); // directory named like .md

    const result = await discoverFn();
    // Only the file should be picked up, not the directory
    expect(result.slash_commands).toEqual(["valid"]);
  });

  it("ignores non-directory entries in skills directory", async () => {
    // Regular files directly under ~/.claude/skills/ should be ignored.
    const skillsDir = join(tempDir, ".claude", "skills");
    mkdirp(skillsDir);
    writeFileSync(join(skillsDir, "stray-file.md"), "not a skill");
    mkdirp(join(skillsDir, "real-skill"));
    writeFileSync(join(skillsDir, "real-skill", "SKILL.md"), "");

    const result = await discoverFn();
    expect(result.skills).toEqual(["real-skill"]);
  });
});
