import { randomUUID } from "node:crypto";

import {
  DESKTOP_REQUEST_ID_HEADER,
  DESKTOP_REQUEST_PATH,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIMESTAMP_HEADER,
  signDesktopRequest,
} from "@companion/companion-runtime/runtime-support";
import { companionDesktopSchema, type CompanionDesktop } from "@companion/contracts";

export class RuntimeDesktopClientError extends Error {
  constructor(
    public readonly code: "not_configured" | "forbidden" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeDesktopClientError";
  }
}

type FetchLike = typeof fetch;

function desktopEndpoint(env: NodeJS.ProcessEnv): URL {
  const raw = env.COMPANION_RUNTIME_PRIVATE_URL?.trim();
  if (!raw) {
    throw new RuntimeDesktopClientError(
      "not_configured",
      "Companion desktop is not configured.",
    );
  }
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new RuntimeDesktopClientError(
      "not_configured",
      "Companion desktop is not configured.",
    );
  }
  if (
    !["http:", "https:"].includes(base.protocol)
    || base.username !== ""
    || base.password !== ""
    || base.search !== ""
    || base.hash !== ""
  ) {
    throw new RuntimeDesktopClientError(
      "not_configured",
      "Companion desktop is not configured.",
    );
  }
  return new URL(DESKTOP_REQUEST_PATH, `${base.origin}/`);
}

function desktopSecret(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.COMPANION_RUNTIME_DESKTOP_HMAC_SECRET?.trim();
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new RuntimeDesktopClientError(
      "not_configured",
      "Companion desktop is not configured.",
    );
  }
  const secret = Buffer.from(raw, "base64");
  const canonical = secret.toString("base64").replace(/=+$/, "");
  if (secret.byteLength !== 32 || canonical !== raw.replace(/=+$/, "")) {
    secret.fill(0);
    throw new RuntimeDesktopClientError(
      "not_configured",
      "Companion desktop is not configured.",
    );
  }
  return secret;
}

/**
 * Mint one short-lived desktop URL through Runtime's private HMAC endpoint. The response body is
 * parsed in memory only and no error includes the private service URL or an upstream payload.
 */
export async function mintCompanionDesktop(input: {
  env: NodeJS.ProcessEnv;
  orgId: string;
  companionId: string;
  actorId: string;
  fetch?: FetchLike;
  now?: () => number;
}): Promise<CompanionDesktop> {
  const endpoint = desktopEndpoint(input.env);
  const secret = desktopSecret(input.env);
  const rawBody = Buffer.from(JSON.stringify({
    actorId: input.actorId,
    companionId: input.companionId,
    orgId: input.orgId,
  }), "utf8");
  const timestamp = Math.floor((input.now?.() ?? Date.now()) / 1_000);
  const requestId = randomUUID();
  let signature: string;
  try {
    signature = signDesktopRequest({
      method: "POST",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      requestId,
      rawBody,
    }, secret);
  } finally {
    secret.fill(0);
  }

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DESKTOP_REQUEST_ID_HEADER]: requestId,
        [DESKTOP_TIMESTAMP_HEADER]: String(timestamp),
        [DESKTOP_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RuntimeDesktopClientError("unavailable", "Companion desktop is unavailable.");
  } finally {
    rawBody.fill(0);
  }

  if (response.status === 403) {
    throw new RuntimeDesktopClientError("forbidden", "Companion desktop is unavailable.");
  }
  if (!response.ok) {
    throw new RuntimeDesktopClientError("unavailable", "Companion desktop is unavailable.");
  }
  try {
    return companionDesktopSchema.parse(await response.json());
  } catch {
    throw new RuntimeDesktopClientError("unavailable", "Companion desktop is unavailable.");
  }
}
