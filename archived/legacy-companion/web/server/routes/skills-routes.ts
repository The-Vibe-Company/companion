import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

const SKILLS_DIR = join(homedir(), ".claude", "skills");

export function registerSkillRoutes(api: Hono): void {
  api.get("/skills", async (c) => {
    try {
      if (!existsSync(SKILLS_DIR)) return c.json([]);
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
      const skills = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(SKILLS_DIR, entry.name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;
        const content = await readFile(skillMdPath, "utf-8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        let name = entry.name;
        let description = "";
        if (fmMatch) {
          for (const line of fmMatch[1].split("\n")) {
            const nameMatch = line.match(/^name:\s*(.+)/);
            if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
            const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
            if (descMatch) description = descMatch[1];
          }
        }
        skills.push({ slug: entry.name, name, description, path: skillMdPath });
      }
      return c.json(skills);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  api.get("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const skillMdPath = join(SKILLS_DIR, slug, "SKILL.md");
    if (!existsSync(skillMdPath)) return c.json({ error: "Skill not found" }, 404);
    const content = await readFile(skillMdPath, "utf-8");
    return c.json({ slug, path: skillMdPath, content });
  });

  api.post("/skills", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name, description, content } = body;
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return c.json({ error: "Invalid name" }, 400);

    const skillDir = join(SKILLS_DIR, slug);
    const skillMdPath = join(skillDir, "SKILL.md");
    if (existsSync(skillMdPath)) {
      return c.json({ error: `Skill "${slug}" already exists` }, 409);
    }

    await mkdir(SKILLS_DIR, { recursive: true });
    await mkdir(skillDir, { recursive: true });

    const md = `---\nname: ${slug}\ndescription: ${JSON.stringify(description || `Skill: ${name}`)}\n---\n\n${content || `# ${name}\n\nDescribe what this skill does and how to use it.\n`}`;
    await writeFile(skillMdPath, md, "utf-8");

    return c.json({ slug, name, description: description || `Skill: ${name}`, path: skillMdPath });
  });

  api.put("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const skillMdPath = join(SKILLS_DIR, slug, "SKILL.md");
    if (!existsSync(skillMdPath)) return c.json({ error: "Skill not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    await writeFile(skillMdPath, body.content, "utf-8");
    return c.json({ ok: true, slug, path: skillMdPath });
  });

  api.delete("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const skillDir = join(SKILLS_DIR, slug);
    if (!existsSync(skillDir)) return c.json({ error: "Skill not found" }, 404);
    await rm(skillDir, { recursive: true, force: true });
    return c.json({ ok: true, slug });
  });
}
