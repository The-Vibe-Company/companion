// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffViewer } from "./DiffViewer.js";

describe("DiffViewer", () => {
  it("renders a diff from old/new text", () => {
    const { container } = render(
      <DiffViewer
        oldText={"const x = 1;\nconst y = 2;"}
        newText={"const x = 42;\nconst y = 2;"}
        fileName="test.ts"
      />,
    );
    expect(container.querySelector(".diff-viewer")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    // File header should show file name
    expect(screen.getByText("test.ts")).toBeTruthy();
  });

  it("renders a diff from unified diff string", () => {
    const unifiedDiff = `diff --git a/src/utils.ts b/src/utils.ts
index 1234567..abcdefg 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 42;
 const c = 3;`;

    const { container } = render(<DiffViewer unifiedDiff={unifiedDiff} />);
    expect(container.querySelector(".diff-viewer")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    // FileHeader splits path into dir + basename spans
    expect(screen.getByText("utils.ts")).toBeTruthy();
  });

  it("renders compact mode without line numbers", () => {
    const { container } = render(
      <DiffViewer
        oldText="hello"
        newText="world"
        mode="compact"
      />,
    );
    expect(container.querySelector(".diff-compact")).toBeTruthy();
    expect(container.querySelector(".diff-gutter")).toBeNull();
  });

  it("renders full mode with line numbers", () => {
    const { container } = render(
      <DiffViewer
        oldText="hello"
        newText="world"
        mode="full"
      />,
    );
    expect(container.querySelector(".diff-full")).toBeTruthy();
    expect(container.querySelector(".diff-gutter")).toBeTruthy();
  });

  it("shows new file diff (old is empty)", () => {
    const { container } = render(
      <DiffViewer
        newText={"export const config = {\n  port: 3000,\n};"}
        fileName="config.ts"
      />,
    );
    const addLines = container.querySelectorAll(".diff-line-add");
    expect(addLines.length).toBeGreaterThan(0);
    // No del lines for new file
    expect(container.querySelector(".diff-line-del")).toBeNull();
  });

  it("shows 'No changes' when old and new are identical", () => {
    render(
      <DiffViewer oldText="same" newText="same" />,
    );
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("shows 'No changes' when both are empty", () => {
    render(<DiffViewer />);
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("renders word-level highlighting", () => {
    const { container } = render(
      <DiffViewer
        oldText={"const value = 1;\nconst other = true;"}
        newText={"const value = 42;\nconst other = true;"}
      />,
    );
    // Word-level diffs should create diff-word-add/diff-word-del spans
    const wordAdds = container.querySelectorAll(".diff-word-add");
    const wordDels = container.querySelectorAll(".diff-word-del");
    expect(wordAdds.length).toBeGreaterThan(0);
    expect(wordDels.length).toBeGreaterThan(0);
  });

  it("renders file path with directory in muted style", () => {
    render(
      <DiffViewer
        oldText="a"
        newText="b"
        fileName="src/components/Button.tsx"
      />,
    );
    expect(screen.getByText("src/components/")).toBeTruthy();
    expect(screen.getByText("Button.tsx")).toBeTruthy();
  });

  it("handles multi-file unified diff", () => {
    const multiDiff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 const b = 1;
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;`;

    const { container } = render(<DiffViewer unifiedDiff={multiDiff} />);
    const files = container.querySelectorAll(".diff-file");
    expect(files.length).toBe(2);
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
  });
});
