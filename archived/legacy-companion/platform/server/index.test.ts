import { describe, it, expect, vi, beforeAll } from "vitest";

// Suppress the console.log that fires when the module is first imported.
// This must happen BEFORE the dynamic import below so that the
// "[companion-cloud] Control plane running on ..." message is silenced.
vi.spyOn(console, "log").mockImplementation(() => {});

// Clear PORT env var so the server falls back to the default (3458).
// In some environments (e.g. when the Companion dev server is running)
// PORT is set to 3456 which would override the default.
const savedPort = process.env.PORT;
delete process.env.PORT;

// Dynamic import after the spy is in place and PORT is cleared.
// The default export exposes { port, fetch }.
const mod = await import("./index");
const server = mod.default;

// Restore PORT after module is loaded so we don't affect other tests.
if (savedPort !== undefined) {
  process.env.PORT = savedPort;
}

describe("server default export", () => {
  it("exports an object with port and fetch properties", () => {
    expect(server).toHaveProperty("port");
    expect(server).toHaveProperty("fetch");
    expect(typeof server.fetch).toBe("function");
  });

  it("defaults port to 3458 when PORT env var is not set", () => {
    // We cleared PORT before the import, so the fallback should be 3458.
    expect(server.port).toBe(3458);
  });
});

describe("GET /health", () => {
  it("returns 200 with { ok: true }", async () => {
    const req = new Request("http://localhost/health");
    const res = await server.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe("GET /api/status", () => {
  it("returns 200 with the expected service descriptor", async () => {
    const req = new Request("http://localhost/api/status");
    const res = await server.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      service: "companion-cloud",
      version: "0.1.0",
      status: "ok",
      provisioning: {
        provider: expect.any(String),
        regions: expect.any(Array),
      },
    });
    expect(body.provisioning.regions.length).toBeGreaterThan(0);
  });

  it("includes CORS headers on /api/* routes", async () => {
    // Send an OPTIONS preflight to verify CORS middleware is active
    const req = new Request("http://localhost/api/status", {
      method: "OPTIONS",
      headers: {
        Origin: "http://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    const res = await server.fetch(req);
    // CORS middleware should set Access-Control-Allow-Origin
    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(allowOrigin).toBeTruthy();
  });
});

describe("unknown routes", () => {
  it("returns 404 for unrecognized paths", async () => {
    // In non-production mode there is no static file catch-all,
    // so unknown routes should return a 404.
    const req = new Request("http://localhost/does-not-exist");
    const res = await server.fetch(req);
    expect(res.status).toBe(404);
  });
});
