import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  COMPANION_ATTACHMENT_FILENAME_MAX_CHARACTERS,
  companionAttachmentSchema,
  companionTranscriptEntrySchema,
  declaredCompanionAttachmentContentType,
  isUtf8TextAttachment,
  sanitizeCompanionAttachmentFilename,
  sniffCompanionAttachmentMime,
} from "../src/companions";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function utf8(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf8"));
}

type TranscriptFixture = z.input<typeof companionTranscriptEntrySchema>;
type AttachmentFixture = z.input<typeof companionAttachmentSchema>;

function entry(overrides: Partial<TranscriptFixture>) {
  return {
    event_id: "msg:0f6f9b0a-1b3f-4f5f-8a2e-6c3d2f1a9b7c",
    ordinal: 0,
    role: "user",
    content: "here",
    author_id: "user-1",
    author_name: "Ada",
    created_at: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

function attachment(overrides: Partial<AttachmentFixture> = {}) {
  return {
    id: "1f7c1c3a-9a2b-4d3e-8f11-0b1c2d3e4f50",
    kind: "user_upload",
    content_type: "image/png",
    byte_size: 12,
    filename: "chart.png",
    position: 0,
    ...overrides,
  };
}

describe("attachment content type sniffing", () => {
  it("identifies images and PDFs from their bytes regardless of the declared type", () => {
    expect(sniffCompanionAttachmentMime(PNG, "text/plain")).toBe("image/png");
    expect(sniffCompanionAttachmentMime(PDF, "text/csv")).toBe("application/pdf");
  });

  it("refuses bytes that claim an image or PDF type but are neither", () => {
    expect(sniffCompanionAttachmentMime(utf8("not an image"), "image/png")).toBeNull();
    expect(sniffCompanionAttachmentMime(utf8("not a pdf"), "application/pdf")).toBeNull();
  });

  it("accepts text formats only when the bytes are well-formed UTF-8 text", () => {
    expect(sniffCompanionAttachmentMime(utf8("a,b\n1,2\n"), "text/csv")).toBe("text/csv");
    expect(sniffCompanionAttachmentMime(utf8("{ not json }"), "application/json"))
      .toBe("application/json");
    expect(sniffCompanionAttachmentMime(new Uint8Array([0x00, 0x01, 0x02]), "text/plain"))
      .toBeNull();
    expect(sniffCompanionAttachmentMime(new Uint8Array([0xc0, 0x80]), "text/plain")).toBeNull();
  });

  it("refuses anything whose type it cannot resolve", () => {
    expect(sniffCompanionAttachmentMime(utf8("hello"), null)).toBeNull();
  });
});

describe("UTF-8 attachment validation", () => {
  it("accepts multi-byte text and the whitespace controls", () => {
    expect(isUtf8TextAttachment(utf8("héllo\tworld\r\n✅"))).toBe(true);
  });

  it("rejects surrogates, overlong forms, truncated tails, and stray controls", () => {
    expect(isUtf8TextAttachment(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false);
    expect(isUtf8TextAttachment(new Uint8Array([0xc0, 0xaf]))).toBe(false);
    expect(isUtf8TextAttachment(new Uint8Array([0xe2, 0x9c]))).toBe(false);
    expect(isUtf8TextAttachment(new Uint8Array([0x07]))).toBe(false);
  });
});

describe("declared content type", () => {
  it("falls back to the extension when the browser sends no usable type", () => {
    expect(declaredCompanionAttachmentContentType({ type: "", name: "notes.MD" }))
      .toBe("text/markdown");
    expect(declaredCompanionAttachmentContentType({ type: "text/csv; charset=utf-8", name: "x" }))
      .toBe("text/csv");
    expect(declaredCompanionAttachmentContentType({ type: "application/zip", name: "x.zip" }))
      .toBeNull();
  });
});

describe("filename sanitizing", () => {
  it("keeps a recognizable name and strips everything outside the stored charset", () => {
    expect(sanitizeCompanionAttachmentFilename({
      filename: "Q3 report (final).pdf",
      position: 1,
      contentType: "application/pdf",
    })).toBe("Q3_report__final_.pdf");
  });

  it("never stages a dotfile and never exceeds the stored length", () => {
    expect(sanitizeCompanionAttachmentFilename({
      filename: ".env",
      position: 0,
      contentType: "text/plain",
    })).toBe("env");
    const long = sanitizeCompanionAttachmentFilename({
      filename: `${"a".repeat(200)}.txt`,
      position: 2,
      contentType: "text/plain",
    });
    expect(long.length).toBe(COMPANION_ATTACHMENT_FILENAME_MAX_CHARACTERS);
  });

  it("falls back to a positional name when nothing survives sanitizing", () => {
    expect(sanitizeCompanionAttachmentFilename({
      filename: "…",
      position: 3,
      contentType: "image/png",
    })).toBe("file-3.png");
  });
});

describe("transcript entry attachments", () => {
  it("defaults to an empty list so older projections stay parseable", () => {
    expect(companionTranscriptEntrySchema.parse(entry({})).attachments).toEqual([]);
  });

  it("lets a member message carry uploads and a reply carry Pi outputs", () => {
    expect(companionTranscriptEntrySchema.parse(entry({ attachments: [attachment()] }))
      .attachments).toHaveLength(1);
    expect(companionTranscriptEntrySchema.parse(entry({
      role: "assistant",
      author_id: null,
      author_name: null,
      attachments: [attachment({ kind: "pi_output" })],
    })).attachments).toHaveLength(1);
  });

  it("keeps expired attachment metadata explicit while accepting an older cached projection", () => {
    expect(companionAttachmentSchema.parse(attachment({
      availability: "expired",
      expires_at: "2026-09-23T12:00:00.000Z",
    }))).toMatchObject({ availability: "expired", expires_at: "2026-09-23T12:00:00.000Z" });
    expect(companionAttachmentSchema.parse(attachment())).toMatchObject({
      availability: "available",
      expires_at: null,
    });
  });

  it("refuses an upload on a reply, a Pi output on a message, and any other role", () => {
    expect(() => companionTranscriptEntrySchema.parse(entry({
      attachments: [attachment({ kind: "pi_output" })],
    }))).toThrow();
    expect(() => companionTranscriptEntrySchema.parse(entry({
      role: "assistant",
      author_id: null,
      author_name: null,
      attachments: [attachment()],
    }))).toThrow();
    expect(() => companionTranscriptEntrySchema.parse(entry({
      role: "system",
      author_id: null,
      author_name: null,
      attachments: [attachment()],
    }))).toThrow();
  });

  it("requires dense ordered positions", () => {
    expect(() => companionTranscriptEntrySchema.parse(entry({
      attachments: [attachment({ position: 1 })],
    }))).toThrow();
  });

  it("refuses a filename outside the stored charset and an oversized file", () => {
    expect(() => companionAttachmentSchema.parse(attachment({ filename: "../escape.png" })))
      .toThrow();
    expect(() => companionAttachmentSchema.parse(attachment({ byte_size: 20 * 1024 * 1024 })))
      .toThrow();
  });
});
