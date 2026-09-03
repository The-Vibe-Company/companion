import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeDesktopPort,
  PostgresRuntimeDesktopAuthorizer,
  PostgresRuntimeDesktopReplayGuard,
  RuntimeDesktopContractError,
} from "./desktop";

const request = {
  orgId: "11111111-1111-4111-8111-111111111111",
  companionId: "22222222-2222-4222-8222-222222222222",
  actorId: "test-user",
};

describe("runtime desktop reauthorization", () => {
  it("delegates replay consumption to the narrow PostgreSQL definer", async () => {
    const unsafe = vi.fn(async () => [{ consumed: true }]);
    const guard = new PostgresRuntimeDesktopReplayGuard({ unsafe });
    await expect(guard.consume({
      requestId: "11111111-1111-4111-8111-111111111111",
      timestamp: 1_800_000_000,
      maxSkewSeconds: 30,
    })).resolves.toBe(true);
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("companion_runtime_consume_desktop_request"),
      ["11111111-1111-4111-8111-111111111111", 1_800_000_000, 30],
    );
  });

  it("calls the narrow definer with a text actor and mints only after authorization", async () => {
    const unsafe = vi.fn(async () => [{
      authorized: true,
      denial_code: null,
      box_id: "bx_23456789",
      box_state: "ready",
      runtime_generation: "1",
    }]);
    const desktop = vi.fn(async () => ({
      url: "https://desktop.example.test/session?token=sensitive",
      provisioning: false,
      transport: "vnc" as const,
    }));
    const port = createRuntimeDesktopPort({
      authorization: new PostgresRuntimeDesktopAuthorizer({ unsafe }),
      box: { desktop },
    });

    await expect(port.authorizeAndMint({
      ...request,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ transport: "vnc" });
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("companion_runtime_authorize_desktop"),
      [request.orgId, request.companionId, "test-user"],
    );
    expect(desktop).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      signal: expect.any(AbortSignal),
    });
  });

  it("retains the non-authoritative v3 compatibility mapping", async () => {
    const authorizer = new PostgresRuntimeDesktopAuthorizer({
      unsafe: async () => [{
        authorized: true,
        denial_code: null,
        box_id: "bx_23456789",
        box_state: "ready",
        runtime_generation: "1",
      }],
    });

    await expect(authorizer.authorize(request)).resolves.toEqual({
      authorized: true,
      denialCode: null,
      boxId: "bx_23456789",
      boxState: "ready",
      runtimeGeneration: 1n,
    });
  });

  it("never contacts Box for any authorization denial", async () => {
    const desktop = vi.fn();
    for (const denialCode of [
      "not_authorized",
      "resource_access_revoked",
      "settings_not_applied",
      "box_unavailable",
      "runtime_disabled",
    ]) {
      const authorization = {
        authorize: vi.fn(async () => ({
          authorized: false,
          denialCode,
          boxId: null,
          boxState: null,
          runtimeGeneration: null,
        })),
      };
      const port = createRuntimeDesktopPort({ authorization, box: { desktop } });
      await expect(port.authorizeAndMint({
        ...request,
        signal: new AbortController().signal,
      })).resolves.toBeNull();
    }
    expect(desktop).not.toHaveBeenCalled();
  });

  it("rejects malformed SQL shapes and a shutdown before Box contact", async () => {
    const malformed = new PostgresRuntimeDesktopAuthorizer({
      unsafe: async () => [{
        authorized: true,
        denial_code: null,
        box_id: null,
        box_state: "running",
        runtime_generation: "1",
      }],
    });
    await expect(malformed.authorize(request)).rejects.toBeInstanceOf(RuntimeDesktopContractError);

    const controller = new AbortController();
    controller.abort(new Error("stopping"));
    const desktop = vi.fn();
    const port = createRuntimeDesktopPort({
      authorization: { authorize: vi.fn() },
      box: { desktop },
    });
    await expect(port.authorizeAndMint({ ...request, signal: controller.signal }))
      .rejects.toThrow("stopping");
    expect(desktop).not.toHaveBeenCalled();
  });
});
