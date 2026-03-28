import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "./rate-limit.js";

function createApp(max: number, windowMs: number) {
  const app = new Hono();
  app.use("/*", rateLimit({ max, windowMs }));
  app.get("/test", (c) => c.text("ok"));
  return app;
}

describe("rateLimit middleware", () => {
  it("should_allow_requests_under_limit", async () => {
    const app = createApp(5, 60_000);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
  });

  it("should_return_429_when_limit_exceeded", async () => {
    const app = createApp(3, 60_000);

    // Exhaust the limit
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }

    // Next request should be blocked
    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too many requests");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("should_set_rate_limit_headers_on_every_response", async () => {
    const app = createApp(10, 60_000);
    const res = await app.request("/test");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("should_decrement_remaining_count_with_each_request", async () => {
    const app = createApp(5, 60_000);

    const res1 = await app.request("/test");
    expect(res1.headers.get("X-RateLimit-Remaining")).toBe("4");

    const res2 = await app.request("/test");
    expect(res2.headers.get("X-RateLimit-Remaining")).toBe("3");

    const res3 = await app.request("/test");
    expect(res3.headers.get("X-RateLimit-Remaining")).toBe("2");
  });

  it("should_show_zero_remaining_when_at_limit", async () => {
    const app = createApp(2, 60_000);
    await app.request("/test");
    await app.request("/test");
    // At limit but not over — next response from the 429 handler
    const res = await app.request("/test");
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});
