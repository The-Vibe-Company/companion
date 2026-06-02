import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Discover slash commands and skills from the filesystem.
 * Used to pre-populate session state before system.init arrives from the CLI.
 *
 * Commands come from:
 *   - ~/.claude/commands/*.md  (user-level)
 *   - {cwd}/.claude/commands/*.md  (project-level)
 *
 * Skills come from:
 *   - ~/.claude/skills/`*`/SKILL.md  (user-level, directory name = slug)
 *
 * Returns sorted, deduplicated arrays. Never throws.
 */
export async function discoverCommandsAndSkills(cwd?: string): Promise<{
  slash_commands: string[];
  skills: string[];
}> {
  const commandSet = new Set<string>();
  const skills: string[] = [];

  const home = homedir();

  // User-level commands: ~/.claude/commands/*.md
  try {
    const userCommandsDir = join(home, ".claude", "commands");
    if (existsSync(userCommandsDir)) {
      const entries = await readdir(userCommandsDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          commandSet.add(e.name.replace(/\.md$/, ""));
        }
      }
    }
  } catch {
    /* gracefully ignore */
  }

  // Project-level commands: {cwd}/.claude/commands/*.md
  if (cwd) {
    try {
      const projectCommandsDir = join(cwd, ".claude", "commands");
      if (existsSync(projectCommandsDir)) {
        const entries = await readdir(projectCommandsDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith(".md")) {
            commandSet.add(e.name.replace(/\.md$/, ""));
          }
        }
      }
    } catch {
      /* gracefully ignore */
    }
  }

  // User-level skills: ~/.claude/skills/*/SKILL.md
  try {
    const skillsDir = join(home, ".claude", "skills");
    if (existsSync(skillsDir)) {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
        if (existsSync(skillMdPath)) {
          skills.push(entry.name);
        }
      }
    }
  } catch {
    /* gracefully ignore */
  }

  const slash_commands = Array.from(commandSet).sort();
  skills.sort();

  return { slash_commands, skills };
}
