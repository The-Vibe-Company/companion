import { afterEach, describe, expect, it, vi } from "vitest";

import { AsciiBoxMaintenanceClient } from "./boxMaintenanceClient";

afterEach(() => vi.unstubAllGlobals());

describe("Box create idempotency", () => {
  it("sends the provider-native key on the create request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(Response.json({
      ok: true,
      type: "box.created",
      status: "provisioning",
      ttlSeconds: 300,
      box: { id: "bx_abcdefgh", name: "temporary" },
    }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AsciiBoxMaintenanceClient({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_API_BASE: "https://box.test/v1/",
    });

    await client.createGenerationBoxAfterObservedAbsence({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 14,
      ttlSeconds: 21_600,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      deadlineAt: Date.now() + 1_000,
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111",
    });
  });
});
