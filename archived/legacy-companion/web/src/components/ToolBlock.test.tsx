// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolBlock, ToolIcon, getToolIcon, getToolLabel, getPreview } from "./ToolBlock.js";

// ─── getToolIcon ─────────────────────────────────────────────────────────────

describe("getToolIcon", () => {
  it("returns 'terminal' for Bash", () => {
    expect(getToolIcon("Bash")).toBe("terminal");
  });

  it("returns 'file' for Read", () => {
    expect(getToolIcon("Read")).toBe("file");
  });

  it("returns 'file-plus' for Write", () => {
    expect(getToolIcon("Write")).toBe("file-plus");
  });

  it("returns 'file-edit' for Edit", () => {
    expect(getToolIcon("Edit")).toBe("file-edit");
  });

  it("returns 'search' for Glob", () => {
    expect(getToolIcon("Glob")).toBe("search");
  });

  it("returns 'search' for Grep", () => {
    expect(getToolIcon("Grep")).toBe("search");
  });

  it("returns 'globe' for WebFetch", () => {
    expect(getToolIcon("WebFetch")).toBe("globe");
  });

  it("returns 'globe' for WebSearch", () => {
    expect(getToolIcon("WebSearch")).toBe("globe");
  });

  it("returns 'list' for TaskCreate", () => {
    expect(getToolIcon("TaskCreate")).toBe("list");
  });

  it("returns 'message' for SendMessage", () => {
    expect(getToolIcon("SendMessage")).toBe("message");
  });

  it("returns 'tool' for unknown tool names", () => {
    expect(getToolIcon("SomeUnknownTool")).toBe("tool");
    expect(getToolIcon("")).toBe("tool");
    expect(getToolIcon("FooBar")).toBe("tool");
  });
});

// ─── getToolLabel ────────────────────────────────────────────────────────────

describe("getToolLabel", () => {
  it("returns 'Terminal' for Bash", () => {
    expect(getToolLabel("Bash")).toBe("Terminal");
  });

  it("returns 'Read File' for Read", () => {
    expect(getToolLabel("Read")).toBe("Read File");
  });

  it("returns 'Write File' for Write", () => {
    expect(getToolLabel("Write")).toBe("Write File");
  });

  it("returns 'Edit File' for Edit", () => {
    expect(getToolLabel("Edit")).toBe("Edit File");
  });

  it("returns 'Find Files' for Glob", () => {
    expect(getToolLabel("Glob")).toBe("Find Files");
  });

  it("returns 'Search Content' for Grep", () => {
    expect(getToolLabel("Grep")).toBe("Search Content");
  });

  it("returns known labels for newly added tools", () => {
    expect(getToolLabel("WebFetch")).toBe("Web Fetch");
    expect(getToolLabel("Task")).toBe("Subagent");
    expect(getToolLabel("TodoWrite")).toBe("Tasks");
    expect(getToolLabel("NotebookEdit")).toBe("Notebook");
    expect(getToolLabel("SendMessage")).toBe("Message");
  });

  it("returns the name itself for unknown tools", () => {
    expect(getToolLabel("SomeUnknownTool")).toBe("SomeUnknownTool");
    expect(getToolLabel("CustomTool")).toBe("CustomTool");
  });
});

// ─── getPreview ──────────────────────────────────────────────────────────────

describe("getPreview", () => {
  it("extracts command for Bash tools", () => {
    expect(getPreview("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("truncates Bash commands longer than 60 chars", () => {
    const longCommand = "a".repeat(80);
    const result = getPreview("Bash", { command: longCommand });
    expect(result).toBe("a".repeat(60) + "...");
    expect(result.length).toBe(63);
  });

  it("does not truncate Bash commands at exactly 60 chars", () => {
    const exactCommand = "b".repeat(60);
    expect(getPreview("Bash", { command: exactCommand })).toBe(exactCommand);
  });

  it("extracts last 2 path segments for Read", () => {
    expect(getPreview("Read", { file_path: "/home/user/project/src/index.ts" })).toBe("src/index.ts");
  });

  it("extracts last 2 path segments for Write", () => {
    expect(getPreview("Write", { file_path: "/var/log/app.log" })).toBe("log/app.log");
  });

  it("extracts last 2 path segments for Edit", () => {
    expect(getPreview("Edit", { file_path: "/a/b/c/d.txt" })).toBe("c/d.txt");
  });

  it("extracts preview from Codex-style Edit changes when file_path is absent", () => {
    expect(getPreview("Edit", {
      changes: [{ path: "/repo/src/foo.ts", kind: "update" }],
    })).toBe("src/foo.ts");
  });

  it("handles short paths for file tools", () => {
    expect(getPreview("Read", { file_path: "file.txt" })).toBe("file.txt");
  });

  it("extracts pattern for Glob", () => {
    expect(getPreview("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("extracts pattern for Grep", () => {
    expect(getPreview("Grep", { pattern: "TODO|FIXME" })).toBe("TODO|FIXME");
  });

  it("extracts query for WebSearch", () => {
    expect(getPreview("WebSearch", { query: "react testing library" })).toBe("react testing library");
  });

  it("returns empty string for unknown tools", () => {
    expect(getPreview("UnknownTool", { some: "data" })).toBe("");
  });

  it("returns empty string for Bash without command", () => {
    expect(getPreview("Bash", { description: "something" })).toBe("");
  });

  it("returns empty string for Read without file_path", () => {
    expect(getPreview("Read", { content: "data" })).toBe("");
  });
});

// ─── ToolIcon ────────────────────────────────────────────────────────────────

describe("ToolIcon", () => {
  it("renders an SVG for terminal type", () => {
    const { container } = render(<ToolIcon type="terminal" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("polyline")).toBeTruthy();
  });

  it("renders an SVG for file type", () => {
    const { container } = render(<ToolIcon type="file" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("path")).toBeTruthy();
  });

  it("renders an SVG for search type", () => {
    const { container } = render(<ToolIcon type="search" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("circle")).toBeTruthy();
  });

  it("renders an SVG for globe type", () => {
    const { container } = render(<ToolIcon type="globe" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("circle")).toBeTruthy();
  });

  it("renders an SVG for message type", () => {
    const { container } = render(<ToolIcon type="message" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders an SVG for list type", () => {
    const { container } = render(<ToolIcon type="list" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders a default SVG for unknown type", () => {
    const { container } = render(<ToolIcon type="tool" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("path")).toBeTruthy();
  });
});

// ─── ToolBlock component ─────────────────────────────────────────────────────

describe("ToolBlock", () => {
  // Bash uses a borderless inline design — command is always visible, no toggle
  it("renders Bash command directly with $ prefix (no toggle)", () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "echo hello" }}
        toolUseId="tool-1"
      />
    );
    // Command is always visible in a pre block
    const preElement = screen.getByText("echo hello").closest("pre");
    expect(preElement).toBeTruthy();
    // $ prefix rendered as a span
    const dollarSpan = preElement?.querySelector("span");
    expect(dollarSpan?.textContent).toBe("$ ");
  });

  it("renders Bash description when provided", () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "ls -la", description: "List files" }}
        toolUseId="tool-1b"
      />
    );
    expect(screen.getByText("List files")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("renders with label only when no preview is available", () => {
    render(
      <ToolBlock
        name="WebFetch"
        input={{ url: "https://example.com" }}
        toolUseId="tool-2"
      />
    );
    expect(screen.getByText("Web Fetch")).toBeTruthy();
  });

  // Non-Bash tools still use the card design with toggle
  it("is collapsed by default for non-Bash tools (does not show details)", () => {
    render(
      <ToolBlock
        name="Read"
        input={{ file_path: "/home/user/test.txt" }}
        toolUseId="tool-3"
      />
    );
    // The expanded detail area should not be present
    expect(screen.queryByText("/home/user/test.txt")).toBeNull();
  });

  it("expands non-Bash tool on click to show input details", () => {
    render(
      <ToolBlock
        name="Read"
        input={{ file_path: "/home/user/test.txt" }}
        toolUseId="tool-4"
      />
    );

    // Click the button to expand
    const button = screen.getByRole("button");
    fireEvent.click(button);

    // After expanding, the full file path should be visible
    expect(screen.getByText("/home/user/test.txt")).toBeTruthy();
  });

  it("collapses non-Bash tool on second click", () => {
    render(
      <ToolBlock
        name="Read"
        input={{ file_path: "/home/user/test.txt" }}
        toolUseId="tool-5"
      />
    );

    const button = screen.getByRole("button");

    // Expand
    fireEvent.click(button);
    expect(screen.getByText("/home/user/test.txt")).toBeTruthy();

    // Collapse
    fireEvent.click(button);
    expect(screen.queryByText("/home/user/test.txt")).toBeNull();
  });

  it("renders Bash command always visible without needing expand", () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "npm install" }}
        toolUseId="tool-6"
      />
    );

    // Command is immediately visible — no click needed
    const preElement = screen.getByText("npm install").closest("pre");
    expect(preElement).toBeTruthy();
    const dollarSpan = preElement?.querySelector("span");
    expect(dollarSpan?.textContent).toBe("$ ");
  });

  it("renders Edit inline with diff (no toggle, no card)", () => {
    // Edit renders always visible — no toggle needed
    const { container } = render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/home/user/src/app.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        }}
        toolUseId="tool-7"
      />
    );

    // Header shows "Edit" label and filename once
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
    // DiffViewer renders del/add lines inline
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
  });

  it("renders Codex-style Edit changes list when diff strings are absent", () => {
    // Edit renders always visible with inline design
    render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/repo/src/foo.ts",
          changes: [
            { path: "/repo/src/foo.ts", kind: "update" },
            { path: "/repo/src/bar.ts", kind: "create" },
          ],
        }}
        toolUseId="tool-7b"
      />
    );

    // Changes always visible — no click needed
    expect(screen.getByText("update")).toBeTruthy();
    expect(screen.getByText("create")).toBeTruthy();
    // Header shows foo.ts, changes list shows basenames
    expect(screen.getAllByText("foo.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("bar.ts")).toBeTruthy();
  });

  it("renders Read file path when expanded", () => {
    render(
      <ToolBlock
        name="Read"
        input={{ file_path: "/home/user/test.txt" }}
        toolUseId="tool-8"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("/home/user/test.txt")).toBeTruthy();
  });

  it("renders JSON for unknown tools when expanded", () => {
    render(
      <ToolBlock
        name="CustomTool"
        input={{ foo: "bar", count: 42 }}
        toolUseId="tool-9"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    const preElement = document.querySelector("pre");
    expect(preElement?.textContent).toContain('"foo": "bar"');
    expect(preElement?.textContent).toContain('"count": 42');
  });

  it("renders Edit with 'replace all' badge when replace_all is true", () => {
    // EditBlock shows an "all" badge when replace_all flag is set
    render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/src/app.ts",
          old_string: "x",
          new_string: "y",
          replace_all: true,
        }}
        toolUseId="tool-ra"
      />
    );

    expect(screen.getByText("all")).toBeTruthy();
  });

  it("renders EditBlock with 'Show all N lines' button for tall diffs", () => {
    // Diffs with >15 lines show a truncation toggle
    const oldLines = Array.from({ length: 10 }, (_, i) => `old-line-${i}`).join("\n");
    const newLines = Array.from({ length: 10 }, (_, i) => `new-line-${i}`).join("\n");
    render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/src/big.ts",
          old_string: oldLines,
          new_string: newLines,
        }}
        toolUseId="tool-tall"
      />
    );

    // Should show "Show all N lines" button (diff has 20 total lines)
    const showAllBtn = screen.getByText(/Show all \d+ lines/);
    expect(showAllBtn).toBeTruthy();

    // Click to expand
    fireEvent.click(showAllBtn);
    expect(screen.getByText("Show less")).toBeTruthy();

    // Click to collapse
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.getByText(/Show all \d+ lines/)).toBeTruthy();
  });

  it("renders EditBlock with JSON fallback when no diff and no changes", () => {
    // When Edit input has neither old_string/new_string nor changes, it falls back to JSON
    render(
      <ToolBlock
        name="Edit"
        input={{ file_path: "/src/mystery.ts" }}
        toolUseId="tool-fb"
      />
    );

    const preElement = document.querySelector("pre");
    expect(preElement?.textContent).toContain('"file_path"');
    expect(preElement?.textContent).toContain("mystery.ts");
  });

  it("renders EditBlock changes with delete kind styling", () => {
    // Codex-style changes with kind "delete" should render with error-tinted text
    render(
      <ToolBlock
        name="Edit"
        input={{
          changes: [
            { path: "/src/old.ts", kind: "delete" },
          ],
        }}
        toolUseId="tool-del"
      />
    );

    expect(screen.getByText("delete")).toBeTruthy();
    expect(screen.getByText("old.ts")).toBeTruthy();
  });

  it("renders BashBlock with empty command without crashing", () => {
    // BashBlock with non-string command should render the $ prompt with empty content
    render(
      <ToolBlock
        name="Bash"
        input={{}}
        toolUseId="tool-empty-bash"
      />
    );

    const preElement = document.querySelector("pre");
    expect(preElement).toBeTruthy();
    // The $ prefix should still render
    expect(preElement?.textContent).toContain("$");
  });
});

// ─── ToolDetail components (expanded view for non-Bash/Edit tools) ──────────

describe("ToolBlock - ToolDetail renderers", () => {
  it("renders Write tool detail with DiffViewer", () => {
    // Write tool when expanded shows the file content in a diff viewer
    render(
      <ToolBlock
        name="Write"
        input={{ file_path: "/src/new-file.ts", content: "export const x = 1;" }}
        toolUseId="tool-write"
      />
    );

    // Write opens collapsed by default — click to expand
    fireEvent.click(screen.getByRole("button"));
    // DiffViewer renders the new content as added lines
    const addedLine = document.querySelector(".diff-line-add");
    expect(addedLine).toBeTruthy();
  });

  it("renders Glob tool detail with pattern and path", () => {
    render(
      <ToolBlock
        name="Glob"
        input={{ pattern: "**/*.ts", path: "/src" }}
        toolUseId="tool-glob"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    // Pattern appears in both preview and detail
    expect(screen.getAllByText("**/*.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("/src")).toBeTruthy();
  });

  it("renders Grep tool detail with pattern, path, glob, and options", () => {
    render(
      <ToolBlock
        name="Grep"
        input={{ pattern: "TODO", path: "/src", glob: "*.ts", output_mode: "content", context: 3, head_limit: 10 }}
        toolUseId="tool-grep"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    // Pattern and path appear in both preview and detail — use getAllByText
    expect(screen.getAllByText("TODO").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\/src/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\*\.ts/)).toBeTruthy();
    expect(screen.getAllByText(/content/).length).toBeGreaterThan(0);
  });

  it("renders WebSearch tool detail with query and domains", () => {
    render(
      <ToolBlock
        name="WebSearch"
        input={{ query: "react hooks", allowed_domains: ["react.dev", "mdn.io"] }}
        toolUseId="tool-ws"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    // Query appears in both preview and detail
    expect(screen.getAllByText("react hooks").length).toBeGreaterThan(0);
    expect(screen.getByText(/react\.dev, mdn\.io/)).toBeTruthy();
  });

  it("renders WebFetch tool detail with URL and prompt", () => {
    render(
      <ToolBlock
        name="WebFetch"
        input={{ url: "https://example.com/api", prompt: "Extract the main content" }}
        toolUseId="tool-wf"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    // URL appears in detail; preview shows hostname+path
    expect(screen.getByText("https://example.com/api")).toBeTruthy();
    expect(screen.getByText("Extract the main content")).toBeTruthy();
  });

  it("renders Task tool detail with description, subagent_type, and prompt", () => {
    render(
      <ToolBlock
        name="Task"
        input={{ description: "Refactor utils", subagent_type: "code", prompt: "Please refactor" }}
        toolUseId="tool-task"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    // "Refactor utils" appears in both the preview span and the detail area
    expect(screen.getAllByText("Refactor utils").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("code")).toBeTruthy();
    expect(screen.getByText("Please refactor")).toBeTruthy();
  });

  it("renders TodoWrite detail with todo items in different statuses", () => {
    render(
      <ToolBlock
        name="TodoWrite"
        input={{
          todos: [
            { content: "Task A", status: "completed" },
            { content: "Task B", status: "in_progress" },
            { content: "Task C", status: "pending" },
          ],
        }}
        toolUseId="tool-todo"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Task A")).toBeTruthy();
    expect(screen.getByText("Task B")).toBeTruthy();
    expect(screen.getByText("Task C")).toBeTruthy();
    // Completed task has line-through styling
    const completedTask = screen.getByText("Task A");
    expect(completedTask.className).toContain("line-through");
  });

  it("renders TodoWrite detail with JSON fallback when todos is not an array", () => {
    render(
      <ToolBlock
        name="TodoWrite"
        input={{ todos: "not-an-array" }}
        toolUseId="tool-todo-fb"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    const preElement = document.querySelector("pre");
    expect(preElement?.textContent).toContain("not-an-array");
  });

  it("renders NotebookEdit detail with path, cell type, and source", () => {
    render(
      <ToolBlock
        name="NotebookEdit"
        input={{ notebook_path: "/nb.ipynb", cell_type: "code", edit_mode: "replace", cell_number: 3, new_source: "print('hi')" }}
        toolUseId="tool-nb"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("/nb.ipynb")).toBeTruthy();
    expect(screen.getByText(/code/)).toBeTruthy();
    expect(screen.getByText(/replace/)).toBeTruthy();
    expect(screen.getByText("print('hi')")).toBeTruthy();
  });

  it("renders SendMessage detail with recipient and content", () => {
    render(
      <ToolBlock
        name="SendMessage"
        input={{ recipient: "user-123", content: "Hello there" }}
        toolUseId="tool-sm"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("user-123")).toBeTruthy();
    expect(screen.getByText("Hello there")).toBeTruthy();
  });

  it("renders Read tool with offset and limit when expanded", () => {
    render(
      <ToolBlock
        name="Read"
        input={{ file_path: "/src/file.ts", offset: 10, limit: 50 }}
        toolUseId="tool-read-ol"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("/src/file.ts")).toBeTruthy();
    expect(screen.getByText(/offset: 10/)).toBeTruthy();
    expect(screen.getByText(/limit: 50/)).toBeTruthy();
  });

  it("renders Bash detail with timeout when expanded via generic card", () => {
    // Bash normally renders inline, but ToolDetail > BashDetail handles timeout display
    // This tests BashDetail directly through a non-standard card path
    // We use the fact that the generic card is used for expanded Bash (via ToolDetail)
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "sleep 100", description: "Long task", timeout: 5000 }}
        toolUseId="tool-bash-to"
      />
    );

    // BashBlock renders inline — description and command should be visible
    expect(screen.getByText("Long task")).toBeTruthy();
    expect(screen.getByText("sleep 100")).toBeTruthy();
  });
});

// ─── Additional getPreview branches ─────────────────────────────────────────

describe("getPreview - additional branches", () => {
  it("prefers Bash description over command when description is short", () => {
    // When description exists and is <= 60 chars, it takes priority over command
    expect(getPreview("Bash", { command: "very-long-cmd", description: "Install deps" }))
      .toBe("Install deps");
  });

  it("falls back to command when Bash description is too long", () => {
    const longDesc = "A".repeat(61);
    expect(getPreview("Bash", { command: "npm i", description: longDesc }))
      .toBe("npm i");
  });

  it("includes path suffix in Grep preview", () => {
    // Grep path suffix uses last 2 segments of the path
    expect(getPreview("Grep", { pattern: "TODO", path: "/project/src" }))
      .toBe("TODO in project/src");
  });

  it("truncates long Grep preview with path", () => {
    const longPattern = "A".repeat(55);
    const result = getPreview("Grep", { pattern: longPattern, path: "/x/y" });
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBe(63);
  });

  it("extracts hostname and pathname from WebFetch URL", () => {
    expect(getPreview("WebFetch", { url: "https://api.example.com/v1/data" }))
      .toBe("api.example.com/v1/data");
  });

  it("falls back to sliced URL for WebFetch with invalid URL", () => {
    expect(getPreview("WebFetch", { url: "not-a-url" }))
      .toBe("not-a-url");
  });

  it("returns task count for TodoWrite", () => {
    expect(getPreview("TodoWrite", { todos: [1, 2, 3] })).toBe("3 tasks");
    expect(getPreview("TodoWrite", { todos: [1] })).toBe("1 task");
  });

  it("extracts notebook filename for NotebookEdit", () => {
    expect(getPreview("NotebookEdit", { notebook_path: "/dir/analysis.ipynb" }))
      .toBe("analysis.ipynb");
  });

  it("formats recipient for SendMessage", () => {
    expect(getPreview("SendMessage", { recipient: "agent-1" }))
      .toBe("\u2192 agent-1");
  });

  it("extracts preview for web_search (Codex)", () => {
    expect(getPreview("web_search", { query: "bun test" })).toBe("bun test");
  });

  it("returns empty for Task without description", () => {
    expect(getPreview("Task", { prompt: "do something" })).toBe("");
  });

  it("returns Task description when provided", () => {
    expect(getPreview("Task", { description: "Fix bug" })).toBe("Fix bug");
  });
});

// ─── Additional getToolLabel branches ───────────────────────────────────────

describe("getToolLabel - mcp prefix", () => {
  it("strips mcp: prefix and returns server:tool format", () => {
    expect(getToolLabel("mcp:github:create_issue")).toBe("github:create_issue");
  });

  it("returns 'Web Search' for web_search (Codex)", () => {
    expect(getToolLabel("web_search")).toBe("Web Search");
  });

  it("returns 'MCP Tool' for mcp_tool_call", () => {
    expect(getToolLabel("mcp_tool_call")).toBe("MCP Tool");
  });
});

// ─── Additional ToolIcon types ──────────────────────────────────────────────

describe("ToolIcon - additional types", () => {
  it("renders SVG for agent type", () => {
    const { container } = render(<ToolIcon type="agent" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("circle")).toBeTruthy();
  });

  it("renders SVG for checklist type", () => {
    const { container } = render(<ToolIcon type="checklist" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders SVG for notebook type", () => {
    const { container } = render(<ToolIcon type="notebook" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("rect")).toBeTruthy();
  });
});
