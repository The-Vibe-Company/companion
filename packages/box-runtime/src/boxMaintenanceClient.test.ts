import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AsciiBoxMaintenanceClient,
  type BoxDeletionOperation,
  type BoxDeletionStatus,
  BoxRuntimeAdapterError,
  companionGenerationBoxName,
} from "./boxMaintenanceClient";
import {
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
} from "./boxCompanionRuntime";

const BOX_ID = "bx_23456789";
const OTHER_BOX_ID = "bx_abcdefgh";
const OPERATION_ID = "bdop_00000000000000000000000000000001";
const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION_NAME = `Companion ${COMPANION_ID} g14`;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function client(): AsciiBoxMaintenanceClient {
  return new AsciiBoxMaintenanceClient({
    COMPANION_BOX_API_KEY: "box_test",
    COMPANION_BOX_API_BASE: "https://box.test/v1/",
  });
}

function operation(
  status: BoxDeletionStatus = "pending",
  overrides: Partial<BoxDeletionOperation> = {},
): BoxDeletionOperation {
  return {
    id: OPERATION_ID,
    targetId: BOX_ID,
    status,
    attemptCount: status === "pending" ? 0 : 1,
    requestedAt: "2026-08-16T00:00:00.001Z",
    completedAt: status === "completed" ? "2026-08-16T00:00:00.003Z" : null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AsciiBoxMaintenanceClient", () => {
  it("requires the Box service key", () => {
    expect(() => new AsciiBoxMaintenanceClient({}))
      .toThrow(BoxRuntimeConfigurationError);
  });

  it("lists every Box page with the provider maximum and opaque cursor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [{ id: BOX_ID, name: "Companion one", state: "archived" }],
        pageInfo: { nextCursor: "page-two", hasMore: true },
      }))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [{ id: OTHER_BOX_ID }],
        pageInfo: { nextCursor: null, hasMore: false },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().listAllBoxes()).resolves.toEqual([
      { id: BOX_ID, name: "Companion one", state: "archived" },
      { id: OTHER_BOX_ID },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://box.test/v1/boxes?limit=200&sort=desc",
      "https://box.test/v1/boxes?limit=200&sort=desc&cursor=page-two",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        headers: { Authorization: "Bearer box_test" },
      });
    }
  });

  it("accepts an official short terminal list response without pageInfo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.list",
      boxes: [{ id: BOX_ID, name: "Companion one" }],
    })));

    await expect(client().listAllBoxes()).resolves.toEqual([
      { id: BOX_ID, name: "Companion one" },
    ]);
  });

  it.each([
    ["success discriminator", { ok: false, type: "box.list", boxes: [] }],
    ["envelope type", { ok: true, type: "boxes", boxes: [] }],
    ["Box id", { ok: true, type: "box.list", boxes: [{ id: "bx_invalid" }] }],
    [
      "terminal cursor",
      {
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: "impossible", hasMore: false },
      },
    ],
  ])("fails closed on an invalid Box list %s", async (_name, envelope) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(envelope)));

    await expect(client().listAllBoxes()).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 502,
      code: "invalid_provider_response",
    });
  });

  it("fails closed when a full page omits pagination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.list",
      boxes: Array.from({ length: 200 }, () => ({ id: BOX_ID })),
    })));

    await expect(client().listAllBoxes()).rejects.toThrow(/omitted pagination/);
  });

  it("fails closed when pagination repeats a cursor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => json({
      ok: true,
      type: "box.list",
      boxes: [],
      pageInfo: { nextCursor: "same-page", hasMore: true },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().listAllBoxes()).rejects.toThrow(/invalid Box list pagination/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the exact irreversible-delete confirmation and retains the operation id", async () => {
    const accepted = operation();
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => json({
      ok: true,
      type: "box.deleting",
      operation: accepted,
    }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).resolves.toEqual({
      outcome: "accepted",
      operation: accepted,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://box.test/v1/boxes/${BOX_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: {
        Authorization: "Bearer box_test",
        "X-Ascii-Confirm-Delete": BOX_ID,
      },
    });
  });

  it("exposes delete 404 as absent without weakening operation polling", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: false,
        code: "box_not_found",
        message: "Box not found",
      }, 404))
      .mockResolvedValueOnce(json({
        ok: false,
        code: "deletion_operation_not_found",
        message: "Deletion operation not found",
      }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).resolves.toEqual({
      outcome: "absent",
      boxId: BOX_ID,
    });
    await expect(client().getDeletionOperation({
      operationId: OPERATION_ID,
      boxId: BOX_ID,
    })).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 404,
      code: "deletion_operation_not_found",
    });
  });

  it.each(["deletion_operation_not_found", "route_not_found", undefined])(
    "does not treat a DELETE 404 with provider code %s as proof that the Box is absent",
    async (code) => {
      vi.stubGlobal("fetch", vi.fn(async () => json({
        ok: false,
        ...(code === undefined ? {} : { code }),
        message: "Not found",
      }, 404)));

      await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).rejects.toMatchObject({
        name: "BoxRuntimeProviderError",
        status: 404,
        stableCode: "box_not_found",
        providerCode: code === "deletion_operation_not_found" ? code : undefined,
      });
    },
  );

  it.each<BoxDeletionStatus>(["pending", "processing", "blocked", "completed"])(
    "accepts and returns the documented %s deletion status",
    async (status) => {
      const current = operation(status);
      const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => json({
        ok: true,
        type: "deletion.operation",
        operation: current,
      }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(client().getDeletionOperation({
        operationId: OPERATION_ID,
        boxId: BOX_ID,
      })).resolves.toEqual(current);
      expect(fetchMock.mock.calls[0]?.[0])
        .toBe(`https://box.test/v1/deletion-operations/${OPERATION_ID}`);
    },
  );

  it("accepts the documented box.deleting discriminator while polling a Box deletion", async () => {
    const current = operation("processing");
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.deleting",
      operation: current,
    })));

    await expect(client().getDeletionOperation({
      operationId: OPERATION_ID,
      boxId: BOX_ID,
    })).resolves.toEqual(current);
  });

  it.each([
    ["unknown status", operation("pending", { status: "unknown" as BoxDeletionStatus })],
    ["malformed operation id", operation("pending", { id: "operation-1" })],
    ["different target", operation("pending", { targetId: OTHER_BOX_ID })],
    ["premature completion time", operation("pending", { completedAt: "2026-08-16T00:00:00Z" })],
    ["missing completion time", operation("completed", { completedAt: null })],
  ])("fails closed on a deletion response with %s", async (_name, invalidOperation) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: invalidOperation,
    })));

    await expect(client().getDeletionOperation({
      operationId: OPERATION_ID,
      boxId: BOX_ID,
    })).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 502,
      code: "invalid_provider_response",
    });
  });

  it("rejects a poll response carrying a different operation id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: operation("pending", {
        id: "bdop_00000000000000000000000000000002",
      }),
    })));

    await expect(client().getDeletionOperation({
      operationId: OPERATION_ID,
      boxId: BOX_ID,
    })).rejects.toThrow(/different deletion operation/);
  });

  it("requires HTTP 202 and the official accepted-delete envelope", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({
      ok: true,
      type: "box.deleting",
      operation: operation(),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID }))
      .rejects.toMatchObject({
        stableCode: "invalid_provider_response",
        retryable: false,
        outcomeUnknown: true,
      });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid JSON", () => new Response("not-json", { status: 202 })],
    ["invalid envelope", () => json({ ok: true, type: "box.deleting" }, 202)],
    [
      "invalid operation id",
      () => json({
        ok: true,
        type: "box.deleting",
        operation: operation("pending", { id: "operation-invalid" }),
      }, 202),
    ],
    [
      "different Box target",
      () => json({
        ok: true,
        type: "box.deleting",
        operation: operation("pending", { targetId: OTHER_BOX_ID }),
      }, 202),
    ],
    [
      "inconsistent operation state",
      () => json({
        ok: true,
        type: "box.deleting",
        operation: operation("completed", { completedAt: null }),
      }, 202),
    ],
  ] as const)(
    "retains outcome uncertainty after DELETE returns %s",
    async (_name, response) => {
      const fetchMock = vi.fn<typeof fetch>(async () => response());
      vi.stubGlobal("fetch", fetchMock);

      await expect(client().requestPermanentDeletion({ boxId: BOX_ID }))
        .rejects.toMatchObject({
          stableCode: "invalid_provider_response",
          retryable: false,
          outcomeUnknown: true,
        });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    },
  );

  it("accepts the documented deletion.operation envelope on DELETE", async () => {
    const accepted = operation();
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: accepted,
    }, 202)));

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).resolves.toEqual({
      outcome: "accepted",
      operation: accepted,
    });
  });

  it("rejects invalid caller ids before contacting Box", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().requestPermanentDeletion({ boxId: "../../all" }))
      .rejects.toBeInstanceOf(BoxRuntimeConfigurationError);
    await expect(client().getDeletionOperation({ operationId: "op-1", boxId: BOX_ID }))
      .rejects.toBeInstanceOf(BoxRuntimeConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps non-404 provider failures without treating them as absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: false,
      code: "delete_blocked",
      message: "Deletion is blocked",
    }, 409)));

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).rejects.toEqual(
      expect.objectContaining<Partial<BoxRuntimeProviderError>>({
        name: "BoxRuntimeProviderError",
        status: 409,
        code: "delete_blocked",
      }),
    );
  });

  it("fails closed on invalid JSON in a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));

    await expect(client().listAllBoxes()).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 502,
      code: "invalid_provider_response",
    });
  });

  it("builds and validates one exact generation-qualified Box name", () => {
    expect(companionGenerationBoxName({ companionId: COMPANION_ID, generation: 14 }))
      .toBe(GENERATION_NAME);
    expect(() => companionGenerationBoxName({ companionId: "../other", generation: 14 }))
      .toThrow(BoxRuntimeConfigurationError);
    expect(() => companionGenerationBoxName({ companionId: COMPANION_ID, generation: 0 }))
      .toThrow(BoxRuntimeConfigurationError);
  });

  it("selects a canonical Box by id and reports only exact-name duplicates", async () => {
    const laterId = "bx_abcdefgh";
    const canonicalId = "bx_23456789";
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.list",
      boxes: [
        { id: laterId, name: GENERATION_NAME },
        { id: "bx_jkmnpqrs", name: `${GENERATION_NAME} ` },
        { id: canonicalId, name: GENERATION_NAME },
        { id: "bx_tuvwxyz2", name: `${GENERATION_NAME} shadow` },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    })));

    await expect(client().findGenerationBoxes({
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() + 1_000,
    })).resolves.toEqual({
      name: GENERATION_NAME,
      canonical: { id: canonicalId, name: GENERATION_NAME },
      duplicates: [{ id: laterId, name: GENERATION_NAME }],
    });
  });

  it("shares only a simultaneous account listing and never caches it after settlement", async () => {
    let release!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => await first)
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = client();
    const input = {
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() + 1_000,
    };
    const left = lifecycle.findGenerationBoxes(input);
    const right = lifecycle.findGenerationBoxes(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(json({
      ok: true,
      type: "box.list",
      boxes: [],
      pageInfo: { nextCursor: null, hasMore: false },
    }));
    await expect(Promise.all([left, right])).resolves.toHaveLength(2);
    await lifecycle.findGenerationBoxes(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a shared provider listing for an already expired or cancelled caller", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = client();

    await expect(lifecycle.findGenerationBoxes({
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() - 1,
    })).rejects.toMatchObject({
      stableCode: "box_request_deadline_exceeded",
      status: 504,
    });

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(lifecycle.findGenerationBoxes({
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() + 1_000,
      signal: cancelled.signal,
    })).rejects.toMatchObject({
      stableCode: "box_request_cancelled",
      status: 499,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces each shared-list waiter's earlier absolute deadline", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async () => await new Promise<Response>((resolve) => {
      release = resolve;
    })));
    const lifecycle = client();
    const first = lifecycle.findGenerationBoxes({
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() + 1_000,
    });
    const second = lifecycle.findGenerationBoxes({
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() + 20,
    });
    const secondResult = expect(second).rejects.toMatchObject({
      stableCode: "box_request_deadline_exceeded",
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(20);
    await secondResult;
    expect(fetch).toHaveBeenCalledTimes(1);

    release(json({
      ok: true,
      type: "box.list",
      boxes: [],
      pageInfo: { nextCursor: null, hasMore: false },
    }));
    await expect(first).resolves.toMatchObject({ canonical: null, duplicates: [] });
  });

  it("does not let the first waiter's short deadline abort a later shared-list waiter", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async () => await new Promise<Response>((resolve) => {
      release = resolve;
    })));
    const lifecycle = client();
    const first = lifecycle.findGenerationBoxes({
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() + 20,
    });
    const second = lifecycle.findGenerationBoxes({
      companionId: COMPANION_ID,
      generation: 14,
      deadlineAt: Date.now() + 1_000,
    });
    const firstResult = expect(first).rejects.toMatchObject({
      stableCode: "box_request_deadline_exceeded",
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(20);
    await firstResult;
    expect(fetch).toHaveBeenCalledTimes(1);
    release(json({
      ok: true,
      type: "box.list",
      boxes: [],
      pageInfo: { nextCursor: null, hasMore: false },
    }));
    await expect(second).resolves.toMatchObject({ canonical: null, duplicates: [] });
  });

  it("recovers the exact-name canonical and duplicates without issuing create", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: true,
      type: "box.list",
      boxes: [
        { id: OTHER_BOX_ID, name: GENERATION_NAME },
        { id: "bx_jkmnpqrs", name: `${GENERATION_NAME} ` },
        { id: BOX_ID, name: GENERATION_NAME },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().createOrRecoverGenerationBox({
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    })).resolves.toEqual({
      outcome: "recovered",
      boxId: BOX_ID,
      name: GENERATION_NAME,
      canonical: { id: BOX_ID, name: GENERATION_NAME },
      duplicates: [{ id: OTHER_BOX_ID, name: GENERATION_NAME }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts one documented 202 create with a bounded orphan TTL and exposes its id", async () => {
    const createdId = OTHER_BOX_ID;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.created",
        status: "provisioning",
        ttlSeconds: 300,
        box: { id: createdId, name: "Box 2026-08-16 21:00" },
      }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().createOrRecoverGenerationBox({
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      setupScript: "install-layout-14",
      environment: "prod",
      env: { COMPANION_ID },
      deadlineAt: Date.now() + 1_000,
    })).resolves.toEqual({
      outcome: "created",
      boxId: createdId,
      name: GENERATION_NAME,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(createInit.method).toBe("POST");
    expect(JSON.parse(String(createInit.body))).toEqual({
      ttlSeconds: 300,
      noEnv: true,
      setupScript: "install-layout-14",
      environment: "prod",
      env: { COMPANION_ID },
    });
  });

  it("creates after observed absence with exactly one POST and no hidden listing", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({
      ok: true,
      type: "box.created",
      status: "provisioning",
      ttlSeconds: 300,
      box: { id: OTHER_BOX_ID, name: "temporary" },
    }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().createGenerationBoxAfterObservedAbsence({
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    })).resolves.toEqual({
      outcome: "created",
      boxId: OTHER_BOX_ID,
      name: GENERATION_NAME,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://box.test/v1/boxes");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });

  it("clones a named snapshot on create when from is supplied", async () => {
    const createdId = OTHER_BOX_ID;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.created",
        status: "cloning",
        ttlSeconds: 300,
        box: { id: createdId, name: "Box 2026-08-19 12:00" },
      }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().createOrRecoverGenerationBox({
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      from: "companion-l14-aaaaaaaaaaaa",
      deadlineAt: Date.now() + 1_000,
    })).resolves.toEqual({
      outcome: "created",
      boxId: createdId,
      name: GENERATION_NAME,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      ttlSeconds: 300,
      noEnv: true,
      from: "companion-l14-aaaaaaaaaaaa",
    });
  });

  it.each(["init", "provisioned", "cloning"] as const)(
    "accepts a 202 create whose lifecycle status is %s",
    async (lifecycleStatus) => {
    const createdId = OTHER_BOX_ID;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.created",
        status: lifecycleStatus,
        ttlSeconds: 300,
        box: { id: createdId, name: "Box 2026-08-16 21:00", state: lifecycleStatus },
      }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().createOrRecoverGenerationBox({
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    })).resolves.toEqual({
      outcome: "created",
      boxId: createdId,
      name: GENERATION_NAME,
    });
  });

  it("leaves a lost create POST outcome unknown without name reconciliation or replay", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }))
      .mockRejectedValueOnce(new TypeError(
        "fetch failed for https://box.test/?token=provider-secret-417",
      ));
    vi.stubGlobal("fetch", fetchMock);

    const failure = await client().createOrRecoverGenerationBox({
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoxRuntimeAdapterError);
    expect(failure).toMatchObject({
      stableCode: "box_network_error",
      retryable: true,
      outcomeUnknown: true,
    });
    expect(String((failure as Error).message)).not.toMatch(/provider-secret|token=|https?:/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects HTTP 201 as an outcome-unknown create contract violation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.created",
        status: "provisioning",
        ttlSeconds: 300,
        box: { id: BOX_ID, name: "provider default" },
      }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().createOrRecoverGenerationBox({
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    })).rejects.toMatchObject({
      stableCode: "invalid_provider_response",
      outcomeUnknown: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["box.updated", "box.info"] as const)(
    "applies deterministic naming and TTL when PATCH returns %s",
    async (type) => {
      const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => json({
        ok: true,
        type,
        box: { id: BOX_ID, name: GENERATION_NAME },
      }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(client().applyGenerationBoxSettings({
        boxId: BOX_ID,
        companionId: COMPANION_ID,
        generation: 14,
        ttlSeconds: 21_600,
        deadlineAt: Date.now() + 1_000,
      })).resolves.toEqual({
        boxId: BOX_ID,
        name: GENERATION_NAME,
        ttlSeconds: 21_600,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://box.test/v1/boxes/${BOX_ID}`);
      const patchInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(patchInit.method).toBe("PATCH");
      expect(JSON.parse(String(patchInit.body))).toEqual({
        name: GENERATION_NAME,
        ttlSeconds: 21_600,
      });
    },
  );

  it("names the rejected PATCH envelope type instead of a generic invalid response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.patched",
      box: { id: BOX_ID, name: GENERATION_NAME },
    })));

    const failure = await client().applyGenerationBoxSettings({
      boxId: BOX_ID,
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      stableCode: "invalid_provider_response",
      outcomeUnknown: true,
    });
    expect(String((failure as Error).message)).toContain("type=box.patched");
    expect(String((failure as Error).message)).toContain("issues=type:");
  });

  it("names an unexpected PATCH HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.updated",
      box: { id: BOX_ID, name: GENERATION_NAME },
    }, 201)));

    const failure = await client().applyGenerationBoxSettings({
      boxId: BOX_ID,
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    }).catch((error: unknown) => error);
    expect(String((failure as Error).message)).toContain("status=201");
    expect(String((failure as Error).message)).toContain("type=box.updated");
  });

  it("leaves a lost settings PATCH outcome unknown without retrying", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("token=provider-secret-417");
    });
    vi.stubGlobal("fetch", fetchMock);

    const failure = await client().applyGenerationBoxSettings({
      boxId: BOX_ID,
      companionId: COMPANION_ID,
      generation: 14,
      ttlSeconds: 21_600,
      deadlineAt: Date.now() + 1_000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoxRuntimeAdapterError);
    expect(failure).toMatchObject({
      stableCode: "box_network_error",
      retryable: true,
      outcomeUnknown: true,
    });
    expect(String((failure as Error).message)).not.toMatch(/provider-secret|token=|https?:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, "box_rate_limited", "rate_limit_secret"],
    [503, "box_provider_unavailable", "provider_dump_secret"],
  ] as const)(
    "maps HTTP %s to a retryable stable error without provider diagnostics",
    async (status, stableCode, secret) => {
      vi.stubGlobal("fetch", vi.fn(async () => json({
        ok: false,
        code: status === 429 ? "rate_limited" : "providersecret417",
        message: `request failed token=${secret} https://signed.test/?secret=${secret}`,
      }, status)));

      const failure = await client().listAllBoxes({
        deadlineAt: Date.now() + 1_000,
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        stableCode,
        retryable: true,
        outcomeUnknown: false,
      });
      expect(String((failure as Error).message)).not.toContain(secret);
      expect(String((failure as Error).message)).not.toMatch(/token=|https?:/);
      if (status === 503) {
        expect(failure).toMatchObject({
          code: "box_provider_unavailable",
          providerCode: undefined,
        });
      }
    },
  );

  it("refuses an elapsed absolute deadline before contacting Box", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().listAllBoxes({ deadlineAt: Date.now() - 1 }))
      .rejects.toMatchObject({
        stableCode: "box_request_deadline_exceeded",
        retryable: true,
        outcomeUnknown: false,
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds a hung request by the absolute deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })));

    await expect(client().listAllBoxes({ deadlineAt: Date.now() + 20 }))
      .rejects.toMatchObject({
        stableCode: "box_request_deadline_exceeded",
        retryable: true,
        outcomeUnknown: false,
      });
  });

  it("waits through asynchronous deletion and returns the retained terminal operation", async () => {
    const pending = operation("pending");
    const completed = operation("completed");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.deleting",
        operation: pending,
      }, 202))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "deletion.operation",
        operation: completed,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().deletePermanentlyAndWait({
      boxId: BOX_ID,
      deadlineAt: Date.now() + 1_000,
      pollIntervalMs: 1,
    })).resolves.toEqual({ outcome: "deleted", operation: completed });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps delete 404 to already_deleted and does not invent an operation", async () => {
    const fetchMock = vi.fn(async () => json({
      ok: false,
      code: "box_not_found",
      message: "not found",
    }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().deletePermanentlyAndWait({
      boxId: BOX_ID,
      deadlineAt: Date.now() + 1_000,
      pollIntervalMs: 1,
    })).resolves.toEqual({ outcome: "already_deleted", boxId: BOX_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls through a blocked deletion until the provider completes it", async () => {
    const blocked = operation("blocked");
    const completed = operation("completed");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "deletion.operation",
        operation: blocked,
      }))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "deletion.operation",
        operation: completed,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().deletePermanentlyAndWait({
      boxId: BOX_ID,
      operationId: OPERATION_ID,
      deadlineAt: Date.now() + 1_000,
      pollIntervalMs: 1,
    })).resolves.toEqual({ outcome: "deleted", operation: completed });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns blocked only after the deletion deadline elapses still blocked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    const blocked = operation("blocked");
    const fetchMock = vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: blocked,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const deletion = client().deletePermanentlyAndWait({
      boxId: BOX_ID,
      operationId: OPERATION_ID,
      deadlineAt: Date.now() + 20,
      pollIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);

    await expect(deletion).resolves.toEqual({ outcome: "blocked", operation: blocked });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicitly empty operation id without issuing DELETE", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().deletePermanentlyAndWait({
      boxId: BOX_ID,
      operationId: "",
      deadlineAt: Date.now() + 1_000,
    })).rejects.toBeInstanceOf(BoxRuntimeConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds pending deletion polling by its shared absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    const pending = operation("pending");
    const fetchMock = vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: pending,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const deletion = client().deletePermanentlyAndWait({
      boxId: BOX_ID,
      operationId: OPERATION_ID,
      deadlineAt: Date.now() + 20,
      pollIntervalMs: 100,
    });
    const rejection = expect(deletion).rejects.toMatchObject({
      stableCode: "box_deletion_deadline_exceeded",
      retryable: true,
      outcomeUnknown: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires an absolute deadline before starting deletion polling", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // @ts-expect-error Runtime validation also protects untyped callers.
    await expect(client().deletePermanentlyAndWait({ boxId: BOX_ID }))
      .rejects.toThrow(/absolute deadline/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
