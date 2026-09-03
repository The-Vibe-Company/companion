import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_REQUEST_ID_HEADER,
  DESKTOP_REQUEST_PATH,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIMESTAMP_HEADER,
  verifyDesktopRequest,
} from "@companion/companion-runtime/runtime-support";
import { mintCompanionDesktop, RuntimeDesktopClientError } from "./runtimeDesktopClient";

const SECRET = Buffer.alloc(32, 23);
const SECRET_BASE64 = SECRET.toString("base64");
const NOW_MS = 1_800_000_000_000;

const identifiers = {
  actorId: "user-1",
  companionId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
};

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COMPANION_RUNTIME_PRIVATE_URL: "http://runtime.internal:4100",
    COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: SECRET_BASE64,
    ...overrides,
  };
}

describe("Runtime desktop private client", () => {
  it("signs the exact serialized body and fixed private path", async () => {
    const captured: { url?: string; init?: RequestInit; rawBody?: Buffer } = {};
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured.url = input.toString();
      captured.init = init;
      captured.rawBody = Buffer.from(init?.body as Uint8Array);
      return Response.json({
        desktop_url: "https://desktop.example.test/short-lived?token=secret",
        provisioning: false,
        automation: "lux",
        transport: "vnc",
      });
    });

    const desktop = await mintCompanionDesktop({
      env: environment(),
      ...identifiers,
      fetch: fetchMock as typeof fetch,
      now: () => NOW_MS,
    });

    expect(desktop).toEqual({
      desktop_url: "https://desktop.example.test/short-lived?token=secret",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
    });
    expect(captured.url).toBe(`http://runtime.internal:4100${DESKTOP_REQUEST_PATH}`);
    expect(captured.rawBody?.toString("utf8")).toBe(JSON.stringify({
      actorId: identifiers.actorId,
      companionId: identifiers.companionId,
      orgId: identifiers.orgId,
    }));
    expect(captured.init?.method).toBe("POST");
    expect(captured.init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(captured.init?.headers);
    const timestamp = Number(headers.get(DESKTOP_TIMESTAMP_HEADER));
    const requestId = headers.get(DESKTOP_REQUEST_ID_HEADER) ?? "";
    expect(timestamp).toBe(NOW_MS / 1_000);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("content-type")).toBe("application/json");
    expect(verifyDesktopRequest({
      method: "POST",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      requestId,
      rawBody: captured.rawBody ?? Buffer.alloc(0),
      signature: headers.get(DESKTOP_SIGNATURE_HEADER) ?? "",
      nowMs: NOW_MS,
    }, SECRET)).toBe(true);
  });

  it.each([
    [{ COMPANION_RUNTIME_PRIVATE_URL: undefined }, "missing URL"],
    [{ COMPANION_RUNTIME_PRIVATE_URL: "file:///tmp/runtime" }, "non-HTTP URL"],
    [{ COMPANION_RUNTIME_PRIVATE_URL: "https://user:pass@runtime.internal" }, "credential URL"],
    [{ COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: undefined }, "missing secret"],
    [{ COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: Buffer.alloc(31).toString("base64") }, "short secret"],
    [{ COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: Buffer.alloc(33).toString("base64") }, "long secret"],
    [{ COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: "not base64!" }, "invalid secret"],
  ])("fails closed for %s (%s)", async (override, _label) => {
    const fetchMock = vi.fn();
    await expect(mintCompanionDesktop({
      env: environment(override),
      ...identifiers,
      fetch: fetchMock,
    })).rejects.toMatchObject({
      code: "not_configured",
      message: "Companion desktop is not configured.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects query-string private URLs without disclosure", async () => {
    const upstreamSecret = "signed-url=https://box.example.test/?token=provider-secret";
    const fetchMock = vi.fn(async () => new Response(upstreamSecret, { status: 403 }));

    const error = await mintCompanionDesktop({
      env: environment({
        COMPANION_RUNTIME_PRIVATE_URL: "https://runtime-secret.internal/private?not-used=1",
      }),
      ...identifiers,
      fetch: fetchMock as typeof fetch,
    }).catch((caught: unknown) => caught);

    // Invalid private configuration is rejected before fetch and exposes neither value.
    expect(error).toBeInstanceOf(RuntimeDesktopClientError);
    expect(error).toMatchObject({
      code: "not_configured",
      message: "Companion desktop is not configured.",
    });
    expect(String(error)).not.toContain("runtime-secret");
    expect(String(error)).not.toContain("provider-secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unavailable"],
    [403, "forbidden"],
    [500, "unavailable"],
  ] as const)("redacts an upstream %s response", async (status, code) => {
    const sensitivePayload = "token=upstream-secret signed_url=https://box.invalid/private";
    const error = await mintCompanionDesktop({
      env: environment(),
      ...identifiers,
      fetch: vi.fn(async () => new Response(sensitivePayload, { status })) as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeDesktopClientError);
    expect(error).toMatchObject({ code, message: "Companion desktop is unavailable." });
    expect(String(error)).not.toContain("upstream-secret");
    expect(String(error)).not.toContain("box.invalid");
  });

  it("accepts an unpadded canonical 32-byte secret", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      desktop_url: "https://desktop.example.test/short-lived",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
    }));

    await expect(mintCompanionDesktop({
      env: environment({
        COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: SECRET_BASE64.replace(/=+$/, ""),
      }),
      ...identifiers,
      fetch: fetchMock as typeof fetch,
      now: () => NOW_MS,
    })).resolves.toMatchObject({ provisioning: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts transport exceptions and invalid success payloads", async () => {
    const thrown = await mintCompanionDesktop({
      env: environment(),
      ...identifiers,
      fetch: vi.fn(async () => {
        throw new Error("runtime.internal token=transport-secret");
      }) as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(thrown).toMatchObject({
      code: "unavailable",
      message: "Companion desktop is unavailable.",
    });
    expect(String(thrown)).not.toContain("transport-secret");

    const invalid = await mintCompanionDesktop({
      env: environment(),
      ...identifiers,
      fetch: vi.fn(async () => Response.json({
        desktop_url: "https://box.invalid/?token=response-secret",
        provisioning: false,
        automation: "unexpected",
        transport: "vnc",
      })) as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(invalid).toMatchObject({
      code: "unavailable",
      message: "Companion desktop is unavailable.",
    });
    expect(String(invalid)).not.toContain("response-secret");
  });
});
