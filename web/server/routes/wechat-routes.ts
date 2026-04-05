// ─── WeChat Bot REST Routes ─────────────────────────────────────────────────
// Management endpoints for the WeChat bot integration.

import type { Hono } from "hono";
import type { WeChatBridge } from "../wechat-bridge.js";

export function registerWeChatRoutes(api: Hono, wechatBridge: WeChatBridge): void {
  // GET /wechat/status — bot status
  api.get("/wechat/status", (c) => {
    const status = wechatBridge.getStatus();
    return c.json(status);
  });

  // POST /wechat/start — start the bot
  api.post("/wechat/start", async (c) => {
    if (wechatBridge.isRunning) {
      return c.json({ ok: true, message: "Already running" });
    }
    try {
      await wechatBridge.start();
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // POST /wechat/stop — stop the bot
  api.post("/wechat/stop", (c) => {
    wechatBridge.stop();
    return c.json({ ok: true });
  });

  // GET /wechat/sessions — list WeChat user sessions
  api.get("/wechat/sessions", (c) => {
    const sessions = wechatBridge.getSessions();
    return c.json({ sessions });
  });

  // DELETE /wechat/sessions/:userId — clean up a user's sessions
  api.delete("/wechat/sessions/:userId", async (c) => {
    const userId = c.req.param("userId");
    await wechatBridge.deleteSessionsForUser(userId);
    return c.json({ ok: true });
  });
}
