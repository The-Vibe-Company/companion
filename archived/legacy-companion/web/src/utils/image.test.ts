// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileAsBase64 } from "./image.js";

describe("readFileAsBase64", () => {
  it("reads a text file and returns base64 + mediaType", async () => {
    // Create a Blob-backed File with known content
    const content = "hello world";
    const file = new File([content], "test.txt", { type: "text/plain" });

    const result = await readFileAsBase64(file);

    // The base64 of "hello world" is "aGVsbG8gd29ybGQ="
    expect(result.base64).toBe("aGVsbG8gd29ybGQ=");
    expect(result.mediaType).toBe("text/plain");
  });

  it("reads an image file and returns correct mediaType", async () => {
    // Create a minimal 1x1 PNG file (valid PNG header)
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
    ]);
    const file = new File([pngBytes], "pixel.png", { type: "image/png" });

    const result = await readFileAsBase64(file);

    expect(result.mediaType).toBe("image/png");
    expect(typeof result.base64).toBe("string");
    expect(result.base64.length).toBeGreaterThan(0);
  });
});
