import { describe, it, expect } from "vitest";
import { isImageFile, langForPath, relPath } from "./file-view-utils.js";

describe("file-view-utils", () => {
  describe("isImageFile", () => {
    it("detects common image extensions case-insensitively", () => {
      // Validates user-facing image preview behavior for mixed-case filenames.
      expect(isImageFile("/tmp/logo.PNG")).toBe(true);
      expect(isImageFile("/tmp/photo.jpeg")).toBe(true);
      expect(isImageFile("/tmp/diagram.svg")).toBe(true);
    });

    it("returns false for non-image extensions", () => {
      // Prevents accidental image mode for regular text/code files.
      expect(isImageFile("/tmp/readme.md")).toBe(false);
      expect(isImageFile("/tmp/main.ts")).toBe(false);
    });
  });

  describe("langForPath", () => {
    it("returns language extensions for all supported extension aliases", () => {
      // Covers every switch branch so language detection remains stable
      // when file-type aliases are used in different repositories.
      const supportedExtensions = [
        "js", "mjs", "cjs",
        "ts", "mts", "cts",
        "jsx", "tsx",
        "css", "scss", "less",
        "html", "htm", "svelte", "vue",
        "json", "jsonc", "json5",
        "md", "mdx", "markdown",
        "py", "pyw", "pyi",
        "rs",
        "c", "h", "cpp", "cxx", "cc", "hpp", "hxx",
        "java",
        "sql",
        "xml", "xsl", "xsd", "svg",
        "yml", "yaml",
      ];

      for (const ext of supportedExtensions) {
        expect(langForPath(`/repo/file.${ext}`)).not.toBeNull();
      }
    });

    it("returns null for unsupported extensions", () => {
      // Unknown files should gracefully fall back to plain text mode.
      expect(langForPath("/repo/file.unknownext")).toBeNull();
    });
  });

  describe("relPath", () => {
    it("returns relative path for normal cwd prefixes", () => {
      // Basic relative conversion used by file trees/editors.
      expect(relPath("/repo", "/repo/src/main.ts")).toBe("src/main.ts");
    });

    it("handles cwd values with trailing slashes", () => {
      // Guards against paths sourced from APIs that include a trailing slash.
      expect(relPath("/repo/", "/repo/src/main.ts")).toBe("src/main.ts");
    });

    it("handles root cwd values", () => {
      // Root cwd should not generate a leading slash-only prefix ("//").
      expect(relPath("/", "/etc/hosts")).toBe("etc/hosts");
    });

    it("returns original path when it is outside cwd", () => {
      // Avoids stripping when path does not belong to the working directory.
      expect(relPath("/repo", "/other/place.txt")).toBe("/other/place.txt");
    });
  });
});
