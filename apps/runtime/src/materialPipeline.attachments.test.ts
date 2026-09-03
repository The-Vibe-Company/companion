import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CompanionBoxRuntime } from "@companion/box-runtime";

import { createRuntimeMaterialPipeline } from "./materialPipeline";

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const masterKey = Buffer.alloc(32, 71);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function outboxEntry(name: string, bytes: Buffer) {
  return {
    name,
    encodedName: Buffer.from(name, "utf8").toString("base64"),
    byteSize: bytes.byteLength,
    sha256: digest(bytes),
  };
}

function pipeline(input: {
  runtime: Partial<CompanionBoxRuntime>;
  storeAttachment?: (stored: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }) => Promise<void>;
  now?: () => number;
}) {
  const options = {
    masterKey,
    apiUrl: "https://api.example.test",
    bundledSkill: {
      slug: "companion",
      version: "1.0.0",
      checksum: `sha256:${"1".repeat(64)}`,
      archive: Buffer.from("bundled"),
    },
    // SAFETY: each test supplies every outbox method it invokes.
    runtime: () => input.runtime as CompanionBoxRuntime,
    loadSkillArchive: vi.fn(),
    storeAttachment: input.storeAttachment ?? vi.fn(async () => undefined),
  };
  if (input.now) Object.assign(options, { now: input.now });
  return createRuntimeMaterialPipeline(options);
}

function harvestInput(deadlineAt = new Date(Date.now() + 90_000)) {
  return {
    orgId,
    companionId,
    boxId: "bx_23456789",
    turnId,
    deadlineAt,
    signal: new AbortController().signal,
  };
}

function harvestRuntime(entries: ReturnType<typeof outboxEntry>[], bytes: Buffer = PNG) {
  return {
    listOutbox: vi.fn(async () => entries),
    readOutboxFile: vi.fn(async ({ entry }: { entry: { name: string } }) => ({
      entry: entries.find((candidate) => candidate.name === entry.name)!,
      bytes,
    })),
  };
}

describe("Runtime v3 Pi outbox harvest", () => {
  it("stores an image under the exact tenant/Companion/Turn content address", async () => {
    const stored: string[] = [];
    const result = await pipeline({
      runtime: harvestRuntime([outboxEntry("plot.png", PNG)]),
      storeAttachment: async ({ key }) => { stored.push(key); },
    }).outboxHarvester.harvestOutbox(harvestInput());

    const key = `companion-attachments/${orgId}/${companionId}/outputs/${turnId}/0-${digest(PNG)}`;
    expect(stored).toEqual([key]);
    expect(result).toEqual({
      attachments: [expect.objectContaining({
        storageKey: key,
        contentType: "image/png",
        byteSize: PNG.byteLength,
        sha256: digest(PNG),
        filename: "plot.png",
      })],
      incomplete: false,
    });
  });

  it("bounds the manifest before transferring bytes", async () => {
    const entries = Array.from({ length: 12 }, (_unused, index) =>
      outboxEntry(`plot-${index}.png`, PNG));
    const runtime = harvestRuntime(entries);
    const result = await pipeline({ runtime }).outboxHarvester.harvestOutbox(harvestInput());

    expect(result.attachments).toHaveLength(10);
    expect(result.incomplete).toBe(true);
    expect(runtime.readOutboxFile).toHaveBeenCalledTimes(10);
  });

  it("rejects oversized and non-image output without persisting it", async () => {
    const oversized = harvestRuntime([
      { ...outboxEntry("huge.png", PNG), byteSize: 11 * 1024 * 1024 },
    ]);
    expect(await pipeline({ runtime: oversized }).outboxHarvester.harvestOutbox(harvestInput()))
      .toEqual({ attachments: [], incomplete: true });
    expect(oversized.readOutboxFile).not.toHaveBeenCalled();

    const text = Buffer.from("plain text");
    const invalid = harvestRuntime([outboxEntry("notes.txt", text)], text);
    expect(await pipeline({ runtime: invalid }).outboxHarvester.harvestOutbox(harvestInput()))
      .toEqual({ attachments: [], incomplete: true });
  });

  it("keeps committed earlier images when a later upload fails", async () => {
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

  it("stops at the wall-clock deadline", async () => {
    const entries = [outboxEntry("first.png", PNG), outboxEntry("second.png", PNG)];
    let clock = 0;
    const runtime = harvestRuntime(entries);
    const result = await pipeline({
      runtime,
      now: () => (clock += 60_000),
    }).outboxHarvester.harvestOutbox(harvestInput(new Date(90_000)));

    expect(result.attachments).toHaveLength(1);
    expect(result.incomplete).toBe(true);
    expect(runtime.readOutboxFile).toHaveBeenCalledTimes(1);
  });

  it("reports an empty outbox as a complete harvest", async () => {
    expect(await pipeline({ runtime: harvestRuntime([]) }).outboxHarvester
      .harvestOutbox(harvestInput())).toEqual({ attachments: [], incomplete: false });
  });
});
