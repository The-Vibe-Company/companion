import type { Hono } from "hono";
import * as promptManager from "../prompt-manager.js";

function sanitizePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((p): p is string => typeof p === "string");
}

export function registerPromptRoutes(api: Hono): void {
  api.get("/prompts", (c) => {
    try {
      const cwd = c.req.query("cwd");
      const scope = c.req.query("scope");
      const normalizedScope =
        scope === "global" || scope === "project" || scope === "all"
          ? scope
          : undefined;
      return c.json(promptManager.listPrompts({ cwd, scope: normalizedScope }));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/prompts/:id", (c) => {
    const prompt = promptManager.getPrompt(c.req.param("id"));
    if (!prompt) return c.json({ error: "Prompt not found" }, 404);
    return c.json(prompt);
  });

  api.post("/prompts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const prompt = promptManager.createPrompt(
        String(body.title || body.name || ""),
        String(body.content || ""),
        body.scope,
        body.cwd ?? body.projectPath,
        sanitizePaths(body.projectPaths),
      );
      return c.json(prompt, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/prompts/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const prompt = promptManager.updatePrompt(c.req.param("id"), {
        name: body.title ?? body.name,
        content: body.content,
        scope: body.scope,
        projectPaths: sanitizePaths(body.projectPaths),
      });
      if (!prompt) return c.json({ error: "Prompt not found" }, 404);
      return c.json(prompt);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/prompts/:id", (c) => {
    const deleted = promptManager.deletePrompt(c.req.param("id"));
    if (!deleted) return c.json({ error: "Prompt not found" }, 404);
    return c.json({ ok: true });
  });
}
