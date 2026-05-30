import type { MiddlewareHandler } from "hono";

/**
 * Hono middleware that sets security response headers on all responses.
 *
 * Headers follow OWASP recommendations and Shinkofa security standards.
 * CSP uses a permissive policy suitable for a SPA with inline styles
 * (Tailwind) and WebSocket connections. Tighten as needed.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    // Prevent MIME-type sniffing
    c.header("X-Content-Type-Options", "nosniff");

    // Prevent clickjacking — DENY unless iframe embedding is needed
    c.header("X-Frame-Options", "DENY");

    // Control referrer information sent with requests
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");

    // HSTS — enforce HTTPS for 2 years, include subdomains
    // Only set when served over HTTPS (detected via X-Forwarded-Proto or direct TLS)
    const proto = c.req.header("x-forwarded-proto") ?? "";
    if (proto === "https" || c.req.url.startsWith("https://")) {
      c.header(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
    }

    // Restrict browser features the app doesn't need
    c.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );

    // Content-Security-Policy — permissive enough for SPA + WebSocket + inline styles
    // 'unsafe-inline' for styles is required by Tailwind's runtime injection
    // connect-src allows ws:/wss: for WebSocket and blob: for recordings
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' ws: wss: blob:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    c.header("Content-Security-Policy", csp);
  };
}
