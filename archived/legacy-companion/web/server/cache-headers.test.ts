import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { cacheControlMiddleware } from "./cache-headers.js";

/**
 * Unit tests for the Cache-Control middleware.
 *
 * Uses a minimal Hono app with mock routes that return 200 for known paths.
 * The middleware runs after the route handler (via await next()) and sets
 * Cache-Control headers based on the request path.
 *
 * Validates that:
 * - sw.js and workbox files get no-cache (browsers must check for updates)
 * - index.html gets no-cache (SW update detection depends on fresh HTML)
 * - manifest.json gets no-cache
 * - Vite hashed assets get immutable caching (content-hashed filenames)
 * - Font files get immutable caching
 * - Icons/images get 1-day cache
 * - API routes get no Cache-Control header (handled by network, not static)
 */
function createTestApp() {
  const app = new Hono();
  app.use("/*", cacheControlMiddleware());

  // Mock routes that simulate serveStatic behavior
  app.get("/sw.js", (c) => c.text("// sw"));
  app.get("/workbox-abc123.js", (c) => c.text("// workbox"));
  app.get("/", (c) => c.html("<html></html>"));
  app.get("/index.html", (c) => c.html("<html></html>"));
  app.get("/manifest.json", (c) => c.json({}));
  app.get("/assets/index-abc123.js", (c) => c.text("// js"));
  app.get("/assets/style-def456.css", (c) => c.text("/* css */"));
  app.get("/fonts/MesloLGSNerdFontMono-Regular.woff2", (c) => c.body("font"));
  app.get("/icon-192.png", (c) => c.body("png"));
  app.get("/favicon.svg", (c) => c.body("svg"));
  app.get("/api/sessions", (c) => c.json([]));

  return app;
}

describe("cacheControlMiddleware", () => {
  const app = createTestApp();

  it("sets no-cache for /sw.js", async () => {
    const res = await app.request("/sw.js");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sets no-cache for workbox runtime files", async () => {
    const res = await app.request("/workbox-abc123.js");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sets no-cache for / (index.html root)", async () => {
    const res = await app.request("/");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sets no-cache for /index.html", async () => {
    const res = await app.request("/index.html");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sets no-cache for /manifest.json", async () => {
    const res = await app.request("/manifest.json");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sets immutable max-age for Vite hashed JS assets", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets immutable max-age for Vite hashed CSS assets", async () => {
    const res = await app.request("/assets/style-def456.css");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets immutable max-age for woff2 font files", async () => {
    const res = await app.request("/fonts/MesloLGSNerdFontMono-Regular.woff2");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets 1-day cache for PNG icons", async () => {
    const res = await app.request("/icon-192.png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("sets 1-day cache for SVG files", async () => {
    const res = await app.request("/favicon.svg");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("does not set Cache-Control for API routes", async () => {
    const res = await app.request("/api/sessions");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
