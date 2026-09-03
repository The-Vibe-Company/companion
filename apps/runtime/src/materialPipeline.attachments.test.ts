/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- Predates the incremental anti-slop gate; file reawakened by a material-contract field addition, existing debt not rewritten here. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeAuthorization, RuntimeWorkMaterial } from "@companion/companion-runtime/runtime-support";
import type { CompanionBoxRuntimeV2 } from "@companion/box-runtime";

import { createRuntimeMaterialPipeline } from "./materialPipeline";
import { RuntimeMaterialError } from "./resourceMaterial";

/**
 * Product promise:
 * A file a member attached reaches Pi as exactly the bytes the control plane accepted, and an image
 * Pi hands back reaches the thread without letting a Box turn one reply into an unbounded read.
 *
 * Why this level:
 * This adapter is the only place where object storage and the Box meet. The engine tests above it
 * use fake ports and cannot see the digest proof, the pre-transfer bounds, or what a partial failure
 * leaves behind; the SQL tests below it never see bytes at all.
 */

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const messageEventId = "msg:44444444-4444-4444-8444-444444444444";
const masterKey = Buffer.alloc(32, 71);

/** A one-pixel PNG. The harvester types outputs from these bytes, not from Pi's chosen name. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function material(overrides: Partial<RuntimeWorkMaterial> = {}): RuntimeWorkMaterial {
  return {
    turnId: null,
    attemptId,
    messageEventId,
    promptText: "look at this",
    turnStartedAt: new Date("2026-08-26T13:42:17.000Z"),
    memberTimezone: "UTC",
    routineId: null,
    routineName: null,
    triggerName: null,
    triggerMode: null,
    routineIsolated: false,
    routineContext: null,
    decisionRequestKind: null,
    decisionResponsePayload: null,
    providerMaterial: [],
    skillMaterial: [],
    mcpMaterial: [],
    modelInput: null,
    hasVisibleOutput: false,
    configCatalog: null,
    attachments: [],
    boxId: null,
    agentEndpoint: null,
    ...overrides,
  };
}

function authorization(): RuntimeAuthorization {
  // Only the immutable ref tuples matter here: the stager rechecks them at the last point before
  // Box contact, and an empty selection is the simplest snapshot that can still drift.
  return { providerRefs: [], skillRefs: [], mcpRefs: [] } as unknown as RuntimeAuthorization;
}

function attachment(bytes: Buffer, position = 0) {
  return {
    id: `9f2a1c40-1b2c-4d3e-8f11-0a1b2c3d4e${String(position).padStart(2, "0")}`,
    storageKey: `companion-attachments/${orgId}/${companionId}/message/${position}-${digest(bytes)}`,
    contentType: "image/png",
    byteSize: bytes.byteLength,
    sha256: digest(bytes),
    filename: `chart-${position}.png`,
    position,
    expiresAt: new Date("2026-09-25T00:00:00.000Z"),
  };
}

function outboxEntry(name: string, bytes: Buffer) {
  return { name, encodedName: Buffer.from(name, "utf8").toString("base64"), byteSize: bytes.byteLength, sha256: digest(bytes) };
}

function pipeline(input: {
  runtime: Partial<CompanionBoxRuntimeV2>;
  loadAttachment?: (key: string, signal: AbortSignal) => Promise<Buffer>;
  storeAttachment?: (stored: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }) => Promise<void>;
  now?: () => number;
}) {
  return createRuntimeMaterialPipeline({
    masterKey,
    apiUrl: "https://api.example.test",
    bundledSkill: {
      slug: "companion",
      version: "1.0.0",
      checksum: `sha256:${"1".repeat(64)}`,
      archive: Buffer.from("bundled"),
    },
    runtime: () => input.runtime as CompanionBoxRuntimeV2,
    loadSkillArchive: vi.fn(),
    loadAttachment: input.loadAttachment ?? vi.fn(async () => PNG),
    storeAttachment: input.storeAttachment ?? vi.fn(async () => undefined),
    ...(input.now ? { now: input.now } : {}),
  });
}

function stageInput(attachments: ReturnType<typeof attachment>[]) {
  return {
    orgId,
    companionId,
    boxId: "bx_23456789",
    messageEventId,
    attachments,
    material: material({ attachments }),
    authorization: authorization(),
    signal: new AbortController().signal,
  };
}

function harvestInput(overrides: { deadlineAt?: Date } = {}) {
  return {
    orgId,
    companionId,
    boxId: "bx_23456789",
    attemptId,
    deadlineAt: overrides.deadlineAt ?? new Date(Date.now() + 90_000),
    signal: new AbortController().signal,
  };
}

describe("staging a member's attachments onto the Box", () => {
  it("stages the exact accepted bytes and names the staged paths", async () => {
    const stageAttachments = vi.fn(async () => [{
      position: 0,
      filename: "chart-0.png",
      contentType: "image/png",
      byteSize: PNG.byteLength,
      path: "~/attachments/44444444-4444-4444-8444-444444444444/0-chart-0.png",
    }]);
    const loadAttachment = vi.fn(async () => PNG);
    const staged = await pipeline({ runtime: { stageAttachments }, loadAttachment })
      .attachmentStager.stageAttachments(stageInput([attachment(PNG)]));

    expect(staged).toHaveLength(1);
    expect(loadAttachment).toHaveBeenCalledWith(attachment(PNG).storageKey, expect.anything());
    // The directory is the client message id the turn owns, so a retry rewrites the same paths.
    expect(stageAttachments).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      messageId: "44444444-4444-4444-8444-444444444444",
      files: [expect.objectContaining({ filename: "chart-0.png", contentType: "image/png" })],
    }));
  });

  it("refuses bytes that are not the bytes the control plane accepted, before any Box call", async () => {
    // A truncated read, a rewritten object, or the wrong key all land here rather than being staged
    // and described to Pi as the member's file.
    const stageAttachments = vi.fn();
    for (const wrong of [Buffer.concat([PNG, Buffer.from([0x99])]), Buffer.from([0x89, 0x50])]) {
      await expect(
        pipeline({ runtime: { stageAttachments }, loadAttachment: async () => wrong })
          .attachmentStager.stageAttachments(stageInput([attachment(PNG)])),
      ).rejects.toBeInstanceOf(RuntimeMaterialError);
    }
    expect(stageAttachments).not.toHaveBeenCalled();
  });

  it("refuses a message event id it cannot turn into a staging directory", async () => {
    const stageAttachments = vi.fn();
    const input = { ...stageInput([attachment(PNG)]), messageEventId: "not-a-message-id" };
    await expect(
      pipeline({ runtime: { stageAttachments } }).attachmentStager.stageAttachments(input),
    ).rejects.toBeInstanceOf(RuntimeMaterialError);
    expect(stageAttachments).not.toHaveBeenCalled();
  });

  it("surfaces an object-storage failure instead of staging a partial set", async () => {
    const stageAttachments = vi.fn();
    await expect(pipeline({
      runtime: { stageAttachments },
      loadAttachment: async () => { throw new Error("object storage is unreachable"); },
    }).attachmentStager.stageAttachments(stageInput([attachment(PNG)]))).rejects.toThrow();
    expect(stageAttachments).not.toHaveBeenCalled();
  });

  it("rechecks the immutable deadline after object read and before Box staging", async () => {
    let clock = Date.parse("2026-09-24T23:59:59.000Z");
    const stageAttachments = vi.fn();
    const loadAttachment = vi.fn(async () => {
      clock = Date.parse("2026-09-25T00:00:00.000Z");
      return PNG;
    });

    await expect(pipeline({
      runtime: { stageAttachments },
      loadAttachment,
      now: () => clock,
    }).attachmentStager.stageAttachments(stageInput([attachment(PNG)])))
      .rejects.toMatchObject({ stableCode: "attachment_expired" });
    expect(stageAttachments).toHaveBeenCalledTimes(1);
    expect(stageAttachments).toHaveBeenCalledWith(expect.objectContaining({ files: [] }));
  });

  it("does not expose staged paths when expiry crosses during the Box write", async () => {
    let clock = Date.parse("2026-09-24T23:59:59.000Z");
    const stageAttachments = vi.fn(async (input: { files: unknown[] }) => {
      if (input.files.length === 0) return [];
      clock = Date.parse("2026-09-25T00:00:00.000Z");
      return [{
        position: 0,
        filename: "chart-0.png",
        contentType: "image/png",
        byteSize: PNG.byteLength,
        path: "~/attachments/message/0-chart-0.png",
      }];
    });

    await expect(pipeline({
      runtime: { stageAttachments },
      now: () => clock,
    }).attachmentStager.stageAttachments(stageInput([attachment(PNG)])))
      .rejects.toMatchObject({ stableCode: "attachment_expired" });
    expect(stageAttachments).toHaveBeenCalledTimes(2);
    expect(stageAttachments).toHaveBeenLastCalledWith(expect.objectContaining({ files: [] }));
  });

  it("keeps a failed expiry cleanup retryable without exposing paths", async () => {
    let clock = Date.parse("2026-09-24T23:59:59.000Z");
    const retryable = Object.assign(new Error("Box cleanup unavailable"), {
      retryable: true,
    });
    const stageAttachments = vi.fn(async (input: { files: unknown[] }) => {
      if (input.files.length === 0) throw retryable;
      clock = Date.parse("2026-09-25T00:00:00.000Z");
      return [];
    });

    await expect(pipeline({
      runtime: { stageAttachments },
      now: () => clock,
    }).attachmentStager.stageAttachments(stageInput([attachment(PNG)]))).rejects.toBe(retryable);
    expect(stageAttachments).toHaveBeenCalledTimes(2);
    expect(stageAttachments).toHaveBeenLastCalledWith(expect.objectContaining({ files: [] }));
  });

  it("clears expired staging even when the attempt is cancelled during the Box write", async () => {
    let clock = Date.parse("2026-09-24T23:59:59.000Z");
    const controller = new AbortController();
    const stageAttachments = vi.fn(async (input: { files: unknown[]; signal?: AbortSignal }) => {
      if (input.files.length === 0) {
        expect(input.signal?.aborted).toBe(false);
        return [];
      }
      clock = Date.parse("2026-09-25T00:00:00.000Z");
      controller.abort();
      return [{
        position: 0,
        filename: "chart-0.png",
        contentType: "image/png",
        byteSize: PNG.byteLength,
        path: "~/attachments/message/0-chart-0.png",
      }];
    });

    await expect(pipeline({
      runtime: { stageAttachments },
      now: () => clock,
    }).attachmentStager.stageAttachments({
      ...stageInput([attachment(PNG)]),
      signal: controller.signal,
    })).rejects.toMatchObject({ stableCode: "attachment_expired" });
    expect(stageAttachments).toHaveBeenCalledTimes(2);
    expect(stageAttachments).toHaveBeenLastCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      messageId: "44444444-4444-4444-8444-444444444444",
      files: [],
      signal: expect.objectContaining({ aborted: false }),
    }));
  });

  it("clears expired staging when a cancelled Box write rejects after persisting bytes", async () => {
    let clock = Date.parse("2026-09-24T23:59:59.000Z");
    const controller = new AbortController();
    const cancellation = new Error("staging cancelled");
    const stageAttachments = vi.fn(async (input: { files: unknown[]; signal?: AbortSignal }) => {
      if (input.files.length === 0) {
        expect(input.signal?.aborted).toBe(false);
        return [];
      }
      clock = Date.parse("2026-09-25T00:00:00.000Z");
      controller.abort(cancellation);
      throw controller.signal.reason;
    });

    await expect(pipeline({
      runtime: { stageAttachments },
      now: () => clock,
    }).attachmentStager.stageAttachments({
      ...stageInput([attachment(PNG)]),
      signal: controller.signal,
    })).rejects.toBe(cancellation);
    expect(stageAttachments).toHaveBeenCalledTimes(2);
    expect(stageAttachments).toHaveBeenLastCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      messageId: "44444444-4444-4444-8444-444444444444",
      files: [],
      signal: expect.objectContaining({ aborted: false }),
    }));
  });
});

describe("harvesting Pi's outbox", () => {
  function harvestRuntime(entries: ReturnType<typeof outboxEntry>[], bytes: Buffer = PNG) {
    return {
      listOutbox: vi.fn(async () => entries),
      readOutboxFile: vi.fn(async ({ entry }: { entry: { name: string } }) => ({
        entry: entries.find((candidate) => candidate.name === entry.name)!,
        bytes,
      })),
    };
  }

  it("stores each image under its content address and reports a complete harvest", async () => {
    const stored: string[] = [];
    let clock = Date.parse("2026-08-26T14:00:00.000Z");
    const result = await pipeline({
      runtime: harvestRuntime([outboxEntry("plot.png", PNG)]),
      storeAttachment: async ({ key }) => {
        stored.push(key);
        clock = Date.parse("2026-08-26T14:00:03.000Z");
      },
      now: () => clock,
    }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.incomplete).toBe(false);
    expect(result.attachments).toEqual([expect.objectContaining({
      contentType: "image/png",
      byteSize: PNG.byteLength,
      sha256: digest(PNG),
      filename: "plot.png",
      uploadedAt: new Date("2026-08-26T14:00:03.000Z"),
    })]);
    expect(stored).toEqual([
      `companion-attachments/${orgId}/${companionId}/outputs/${attemptId}/0-${digest(PNG)}`,
    ]);
  });

  it("takes at most ten files and says so, before it transfers anything", async () => {
    const entries = Array.from({ length: 12 }, (_unused, index) =>
      outboxEntry(`plot-${index}.png`, PNG));
    const runtime = harvestRuntime(entries);
    const result = await pipeline({ runtime }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.attachments).toHaveLength(10);
    expect(result.incomplete).toBe(true);
    // The bound is applied to the manifest, not after reading twelve files off the Box.
    expect(runtime.readOutboxFile).toHaveBeenCalledTimes(10);
  });

  it("drops a file larger than one attachment may be without reading it", async () => {
    const runtime = harvestRuntime([
      { ...outboxEntry("huge.png", PNG), byteSize: 11 * 1024 * 1024 },
      outboxEntry("plot.png", PNG),
    ]);
    const result = await pipeline({ runtime }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.attachments.map((entry) => entry.filename)).toEqual(["plot.png"]);
    expect(result.incomplete).toBe(true);
    expect(runtime.readOutboxFile).toHaveBeenCalledTimes(1);
  });

  it("drops a file whose bytes are not an image Pi may hand back", async () => {
    const result = await pipeline({
      runtime: harvestRuntime([outboxEntry("notes.txt", Buffer.from("plain text"))],
        Buffer.from("plain text")),
    }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.attachments).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it("loses one unreadable file, never the rest of the harvest", async () => {
    const entries = [outboxEntry("bad.png", PNG), outboxEntry("good.png", PNG)];
    const result = await pipeline({
      runtime: {
        listOutbox: vi.fn(async () => entries),
        readOutboxFile: vi.fn(async ({ entry }: { entry: { name: string } }) => {
          if (entry.name === "bad.png") throw new Error("chunk never arrived whole");
          return { entry: entries[1]!, bytes: PNG };
        }),
      },
    }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.attachments.map((entry) => entry.filename)).toEqual(["good.png"]);
    expect(result.incomplete).toBe(true);
  });

  it("keeps the images it already stored when a later upload fails", async () => {
    // A reply is already durable by this point, so one failed upload must cost one image rather
    // than the whole harvest -- and must not silently orphan the objects already written.
    const entries = [outboxEntry("first.png", PNG), outboxEntry("second.png", PNG)];
    let uploads = 0;
    const result = await pipeline({
      runtime: harvestRuntime(entries),
      storeAttachment: async () => {
        uploads += 1;
        if (uploads === 2) throw new Error("object storage rejected the upload");
      },
    }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.attachments.map((entry) => entry.filename)).toEqual(["first.png"]);
    expect(result.incomplete).toBe(true);
  });

  it("stops at its wall-clock budget and reports the shortfall", async () => {
    const entries = [outboxEntry("first.png", PNG), outboxEntry("second.png", PNG)];
    let clock = 0;
    const runtime = harvestRuntime(entries);
    const result = await pipeline({
      runtime,
      // Elapses past the deadline after the first file.
      now: () => (clock += 60_000),
    }).outboxHarvester.harvestOutbox(harvestInput({ deadlineAt: new Date(90_000) }));

    expect(result.attachments).toHaveLength(1);
    expect(result.incomplete).toBe(true);
    expect(runtime.readOutboxFile).toHaveBeenCalledTimes(1);
  });

  it("drops a zero-byte file and counts it as a shortfall", async () => {
    const runtime = harvestRuntime([
      { ...outboxEntry("empty.png", PNG), byteSize: 0 },
      outboxEntry("plot.png", PNG),
    ]);
    const result = await pipeline({ runtime }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.attachments.map((entry) => entry.filename)).toEqual(["plot.png"]);
    expect(result.incomplete).toBe(true);
    expect(runtime.readOutboxFile).toHaveBeenCalledTimes(1);
  });

  it("reports an empty outbox as a complete harvest, not a degraded one", async () => {
    const result = await pipeline({ runtime: harvestRuntime([]) })
      .outboxHarvester.harvestOutbox(harvestInput());

    expect(result).toEqual({ attachments: [], incomplete: false });
  });
});
