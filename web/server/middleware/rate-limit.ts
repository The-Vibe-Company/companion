import type { MiddlewareHandler } from "hono";

interface RateLimitOptions {
  /** Maximum requests allowed in the window */
  max: number;
  /** Time window in milliseconds */
  windowMs: number;
  /**
   * Whether to trust proxy headers (X-Forwarded-For).
   * Only enable this when running behind a trusted reverse proxy.
   * Default: false
   */
  trustProxy?: boolean;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter middleware for Hono.
 *
 * Uses IP-based tracking with automatic cleanup of expired entries.
 * Suitable for single-instance deployments (Takumi-T use case).
 *
 * Returns 429 Too Many Requests when limit is exceeded.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { max, windowMs, trustProxy = false } = options;
  const store = new Map<string, RateLimitEntry>();

  // Periodic cleanup every 60 seconds to prevent memory leak
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key);
    }
  }, 60_000);

  // Allow cleanup timer to not prevent process exit
  if (cleanupInterval.unref) cleanupInterval.unref();

  return async (c, next) => {
    const ip = getClientIp(c, trustProxy) ?? "unknown";
    const now = Date.now();

    let entry = store.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(ip, entry);
    }

    entry.count++;

    // Set rate limit headers (RFC 6585 / draft-ietf-httpapi-ratelimit-headers)
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}

/**
 * Extract client IP from request.
 *
 * When trustProxy is false (default), X-Forwarded-For is ignored to prevent
 * IP spoofing. Only x-real-ip (typically set by a trusted reverse proxy at
 * the network level) or the connection remote address are used.
 *
 * When trustProxy is true, the RIGHTMOST IP in X-Forwarded-For is used
 * because it is the one appended by the closest trusted proxy, whereas the
 * leftmost value is client-controlled and trivially spoofable.
 */
function getClientIp(c: { req: { header: (name: string) => string | undefined }; env?: unknown }, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
      // Rightmost IP is appended by the closest trusted proxy
      return parts[parts.length - 1];
    }
  }

  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp;

  // Bun server requestIP
  const bunServer = c.env as { requestIP?: (req: Request) => { address: string } | null };
  if (bunServer?.requestIP) {
    const raw = (c as any).req?.raw;
    if (raw) {
      const ip = bunServer.requestIP(raw);
      if (ip) return ip.address;
    }
  }

  return undefined;
}
