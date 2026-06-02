import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

/**
 * Auth middleware for managed Companion Cloud instances.
 *
 * Only active when COMPANION_AUTH_ENABLED=1. Validates a JWT from a cookie
 * or query parameter, signed by the control plane using COMPANION_AUTH_SECRET.
 *
 * Skipped paths:
 *  - /ws/cli/*  — internal CLI WebSocket (Claude Code connects from within the machine)
 *  - /health    — monitoring endpoint used by control plane health checks
 */
export const managedAuth = createMiddleware(async (c: Context, next) => {
  // This middleware is only registered by index.ts when managed auth is
  // enabled (COMPANION_AUTH_ENABLED=1 or COMPANION_AUTH_SECRET is set).
  // No redundant env check needed here.

  const path = c.req.path;

  // Internal paths that bypass auth
  if (path.startsWith("/ws/cli/") || path === "/health") return next();

  const cookieToken = getCookie(c, "companion_token");
  const queryToken = c.req.query("token");
  // Give explicit URL token precedence so reconnect links can always override
  // stale/expired cookies in the browser.
  const token = queryToken || cookieToken;

  if (!token) {
    return redirectOrUnauthorized(c);
  }

  const secret = process.env.COMPANION_AUTH_SECRET;
  if (!secret) {
    console.error("[managed-auth] COMPANION_AUTH_SECRET is not set");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  const valid = await verifyToken(token, secret);
  if (!valid) {
    return redirectOrUnauthorized(c);
  }

  // When auth arrives via URL query once, persist it to a cookie so static
  // assets and subsequent API calls are authenticated without ?token=...
  if (queryToken && queryToken !== cookieToken) {
    setAuthCookie(c, queryToken);
  }

  return next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCookie(c: Context, name: string): string | undefined {
  const header = c.req.header("cookie");
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

function setAuthCookie(c: Context, token: string): void {
  const encoded = encodeURIComponent(token);
  const secure = shouldUseSecureCookie(c) ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `companion_token=${encoded}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=900`,
  );
}

function shouldUseSecureCookie(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto) return forwardedProto === "https";

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return true;
  }
}

function redirectOrUnauthorized(c: Context): Response {
  const loginUrl = process.env.COMPANION_LOGIN_URL;
  if (loginUrl) {
    return c.redirect(loginUrl);
  }
  return c.json({ error: "Unauthorized" }, 401);
}

/**
 * Verify a JWT-like HMAC-SHA256 token.
 * Token format: base64url(payload).base64url(signature)
 * Payload: { exp: number } (Unix seconds)
 */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payloadB64, signatureB64] = parts;

  // Verify signature using HMAC-SHA256
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadB64),
  );

  const expectedB64 = base64UrlEncode(new Uint8Array(expectedSig));
  if (!timingSafeEqual(expectedB64, signatureB64)) return false;

  // Check expiration
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    );
    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Create a signed token for the control plane to issue.
 * Exported for use by the control plane's token endpoint.
 */
export async function createToken(
  secret: string,
  ttlSeconds = 900, // 15 minutes
): Promise<string> {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );

  return `${payloadB64}.${base64UrlEncode(new Uint8Array(sig))}`;
}

// ─── Base64url ───────────────────────────────────────────────────────────────

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
