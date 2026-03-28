import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "./security-headers.js";

function createApp() {
  const app = new Hono();
  app.use("/*", securityHeaders());
  app.get("/test", (c) => c.text("ok"));
  return app;
}

describe("securityHeaders middleware", () => {
  it("should_set_x_content_type_options_when_responding", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("should_set_x_frame_options_deny_when_responding", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("should_set_referrer_policy_when_responding", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("should_set_permissions_policy_when_responding", async () => {
    const app = createApp();
    const res = await app.request("/test");
    expect(res.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
  });

  it("should_set_csp_with_self_and_websocket_when_responding", async () => {
    const app = createApp();
    const res = await app.request("/test");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ws: wss: blob:");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("should_set_hsts_when_request_is_https", async () => {
    const app = createApp();
    const res = await app.request("/test", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    const hsts = res.headers.get("Strict-Transport-Security");
    expect(hsts).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("should_not_set_hsts_when_request_is_http", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/test");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });
});
