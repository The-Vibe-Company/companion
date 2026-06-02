import { verifyToken } from "./middleware/managed-auth.js";

export interface WsAuthResult {
  ok: boolean;
  status: number;
  body?: string;
}

function getCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

/**
 * Authenticate browser/terminal WebSocket upgrade requests in managed mode.
 * Accepts token in query param or companion_token cookie (query takes precedence).
 */
export async function authenticateManagedWebSocket(req: Request): Promise<WsAuthResult> {
  const secret = process.env.COMPANION_AUTH_SECRET?.trim();
  if (!secret) {
    return { ok: false, status: 500, body: "Server misconfigured" };
  }

  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  const cookieToken = getCookie(req.headers.get("cookie"), "companion_token");
  const token = queryToken || cookieToken;

  if (!token) {
    return { ok: false, status: 401, body: "Unauthorized" };
  }

  const valid = await verifyToken(token, secret);
  if (!valid) {
    return { ok: false, status: 401, body: "Unauthorized" };
  }

  return { ok: true, status: 200 };
}

