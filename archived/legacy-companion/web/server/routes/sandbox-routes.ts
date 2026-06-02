import { resolve } from "node:path";
import type { Hono } from "hono";
import * as sandboxManager from "../sandbox-manager.js";
import { containerManager, type ContainerConfig } from "../container-manager.js";
import { imagePullManager } from "../image-pull-manager.js";

export function registerSandboxRoutes(
  api: Hono,
): void {
  api.get("/sandboxes", (c) => {
    try {
      return c.json(sandboxManager.listSandboxes());
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/sandboxes/:slug", (c) => {
    const sandbox = sandboxManager.getSandbox(c.req.param("slug"));
    if (!sandbox) return c.json({ error: "Sandbox not found" }, 404);
    return c.json(sandbox);
  });

  api.post("/sandboxes", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const sandbox = sandboxManager.createSandbox(body.name, {
        initScript: body.initScript,
      });
      return c.json(sandbox, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/sandboxes/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    try {
      const sandbox = sandboxManager.updateSandbox(slug, {
        name: body.name,
        initScript: body.initScript,
      });
      if (!sandbox) return c.json({ error: "Sandbox not found" }, 404);
      return c.json(sandbox);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/sandboxes/:slug", (c) => {
    try {
      const deleted = sandboxManager.deleteSandbox(c.req.param("slug"));
      if (!deleted) return c.json({ error: "Sandbox not found" }, 404);
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Test the init script of a sandbox in an ephemeral container.
  // Accepts an optional `initScript` body param to test unsaved content
  // without persisting it first. Falls back to the stored script.
  api.post("/sandboxes/:slug/test-init", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    const rawCwd = body.cwd;

    const sandbox = sandboxManager.getSandbox(slug);
    if (!sandbox) return c.json({ error: "Sandbox not found" }, 404);

    // Prefer body initScript (unsaved draft) over stored value
    const initScript = (typeof body.initScript === "string" ? body.initScript : sandbox.initScript ?? "").trim();
    if (!initScript) return c.json({ error: "No init script configured for this sandbox" }, 400);
    if (!rawCwd) return c.json({ error: "Working directory (cwd) is required" }, 400);

    // Require an absolute path from the caller, then normalize
    const cwdStr = String(rawCwd);
    if (!cwdStr.startsWith("/")) return c.json({ error: "Working directory must be an absolute path" }, 400);
    const cwd = resolve(cwdStr);

    if (!containerManager.checkDocker()) return c.json({ error: "Docker is not available" }, 503);

    const effectiveImage = "the-companion:latest";
    if (!imagePullManager.isReady(effectiveImage)) {
      return c.json({ error: `Docker image ${effectiveImage} is not available. Pull it first.` }, 503);
    }

    const tempId = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    let containerId: string | undefined;

    try {
      const config: ContainerConfig = {
        image: effectiveImage,
        ports: [],
      };
      const containerInfo = containerManager.createContainer(tempId, cwd, config);
      containerId = containerInfo.containerId;

      await containerManager.copyWorkspaceToContainer(containerId, cwd);

      const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
      const result = await containerManager.execInContainerAsync(
        containerId,
        ["sh", "-lc", initScript],
        { timeout: initTimeout },
      );

      const output = result.output.length > 2000
        ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
        : result.output;

      return c.json({
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        output,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ success: false, exitCode: -1, output: msg }, 500);
    } finally {
      if (containerId) {
        try { containerManager.removeContainer(tempId); } catch { /* best effort cleanup */ }
      }
    }
  });
}
