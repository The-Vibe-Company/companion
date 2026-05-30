// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import type { ChatMessage, ContentBlock } from "../types.js";

// Mock react-markdown to exercise custom component renderers while avoiding ESM/parsing issues.
// The mock invokes each custom component from the `components` prop so coverage reaches those lines.
vi.mock("react-markdown", () => ({
  default: ({ children, components }: { children: string; components?: Record<string, Function> }) => {
    if (!components) return <div data-testid="markdown">{children}</div>;

    // Exercise all custom component renderers to achieve coverage on MarkdownContent
    const renderers: React.ReactNode[] = [];
    const C = components as Record<string, React.FC<Record<string, unknown>>>;

    if (C.p) renderers.push(<C.p key="p">{children}</C.p>);
    if (C.strong) renderers.push(<C.strong key="strong">bold</C.strong>);
    if (C.em) renderers.push(<C.em key="em">italic</C.em>);
    if (C.h1) renderers.push(<C.h1 key="h1">Heading 1</C.h1>);
    if (C.h2) renderers.push(<C.h2 key="h2">Heading 2</C.h2>);
    if (C.h3) renderers.push(<C.h3 key="h3">Heading 3</C.h3>);
    if (C.ul) renderers.push(<C.ul key="ul"><li>item</li></C.ul>);
    if (C.ol) renderers.push(<C.ol key="ol"><li>item</li></C.ol>);
    if (C.li) renderers.push(<C.li key="li">list item</C.li>);
    if (C.a) renderers.push(<C.a key="a" href="https://example.com">link</C.a>);
    if (C.blockquote) renderers.push(<C.blockquote key="bq">quote</C.blockquote>);
    if (C.hr) renderers.push(<C.hr key="hr" />);
    if (C.pre) renderers.push(<C.pre key="pre"><code>pre code</code></C.pre>);
    if (C.table) renderers.push(<C.table key="table"><tbody><tr><td>cell</td></tr></tbody></C.table>);
    if (C.thead) renderers.push(<C.thead key="thead"><tr><th>head</th></tr></C.thead>);
    if (C.th) renderers.push(<C.th key="th">header</C.th>);
    if (C.td) renderers.push(<C.td key="td">data</C.td>);
    // Exercise code renderer with both inline and block variants
    if (C.code) {
      renderers.push(<C.code key="inline-code">inline</C.code>);
      renderers.push(<C.code key="block-code" className="language-typescript">{"const x = 1;\nconst y = 2;"}</C.code>);
      // Block code without language (multiline string)
      renderers.push(<C.code key="block-noclass">{"line1\nline2"}</C.code>);
    }

    return <div data-testid="markdown">{renderers}</div>;
  },
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

import { MessageBubble } from "./MessageBubble.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── System messages ─────────────────────────────────────────────────────────

describe("MessageBubble - system messages", () => {
  it("renders system message with italic text", () => {
    const msg = makeMessage({ role: "system", content: "Session started" });
    const { container } = render(<MessageBubble message={msg} />);

    const italicSpan = container.querySelector(".italic");
    expect(italicSpan).toBeTruthy();
    expect(italicSpan?.textContent).toBe("Session started");
  });

  it("renders system message with divider lines", () => {
    const msg = makeMessage({ role: "system", content: "Divider test" });
    const { container } = render(<MessageBubble message={msg} />);

    // There should be 2 divider elements (h-px)
    const dividers = container.querySelectorAll(".h-px");
    expect(dividers.length).toBe(2);
  });
});

// ─── User messages ───────────────────────────────────────────────────────────

describe("MessageBubble - user messages", () => {
  it("renders user message right-aligned with content", () => {
    const msg = makeMessage({ role: "user", content: "Hello Claude" });
    const { container } = render(<MessageBubble message={msg} />);

    // Check for right-alignment (justify-end)
    const wrapper = container.querySelector(".justify-end");
    expect(wrapper).toBeTruthy();

    // Check content
    expect(screen.getByText("Hello Claude")).toBeTruthy();
  });

  it("renders user messages with image thumbnails", () => {
    const msg = makeMessage({
      role: "user",
      content: "See this image",
      images: [
        { media_type: "image/png", data: "abc123base64" },
        { media_type: "image/jpeg", data: "def456base64" },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    const images = container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(images[0].getAttribute("src")).toBe("data:image/png;base64,abc123base64");
    expect(images[1].getAttribute("src")).toBe("data:image/jpeg;base64,def456base64");
    expect(images[0].getAttribute("alt")).toBe("attachment");
  });

  it("does not render images section when images array is empty", () => {
    const msg = makeMessage({ role: "user", content: "No images", images: [] });
    const { container } = render(<MessageBubble message={msg} />);

    const images = container.querySelectorAll("img");
    expect(images.length).toBe(0);
  });
});

// ─── Assistant messages ──────────────────────────────────────────────────────

describe("MessageBubble - assistant messages", () => {
  it("renders plain text assistant message with markdown", () => {
    const msg = makeMessage({ role: "assistant", content: "Hello world" });
    render(<MessageBubble message={msg} />);

    // Our mock renders content inside data-testid="markdown" along with exercised component renderers
    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toContain("Hello world");
  });

  it("renders assistant message with text content blocks", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "text", text: "Here is the answer" },
      ],
    });
    render(<MessageBubble message={msg} />);

    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toContain("Here is the answer");
  });

  it("renders tool_use content blocks as ToolBlock components", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Bash renders inline with $ prefix and command visible directly
    expect(screen.getByText("pwd")).toBeTruthy();
    const preElement = screen.getByText("pwd").closest("pre");
    expect(preElement).toBeTruthy();
  });

  it("renders thinking blocks as inline faded italic text", () => {
    const thinkingText = "Let me analyze this problem step by step...";
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: thinkingText },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Thinking renders inline as faded italic text via Markdown mock
    expect(screen.getByText(thinkingText)).toBeTruthy();
  });

  it("thinking blocks show 'Show more' for long content", () => {
    // Use text with many lines so it triggers the isLong threshold
    const thinkingLines = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: analysis of the problem`);
    const thinkingText = thinkingLines.join("\n");
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: thinkingText },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Long text is truncated, "Show more" button appears
    expect(screen.getByText("Show more")).toBeTruthy();

    // Click to expand
    fireEvent.click(screen.getByText("Show more"));

    // After expanding, "Show more" disappears (no collapse toggle)
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("renders tool_result blocks with string content", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-1", content: "Command output: success" },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Command output: success")).toBeTruthy();
  });

  it("renders tool_result blocks with JSON content", () => {
    const jsonContent = [{ type: "text" as const, text: "nested result" }];
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-2", content: jsonContent as unknown as string },
      ],
    });
    render(<MessageBubble message={msg} />);

    // The JSON.stringify of the content should be rendered
    const rendered = screen.getByText(JSON.stringify(jsonContent));
    expect(rendered).toBeTruthy();
  });

  it("renders tool_result error blocks with error styling", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-3", content: "Error: file not found", is_error: true },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    expect(screen.getByText("Error: file not found")).toBeTruthy();
    // Check for error styling class
    const errorDiv = container.querySelector(".text-cc-error");
    expect(errorDiv).toBeTruthy();
  });

  it("renders non-error tool_result without error styling", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-4", content: "Success output" },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    expect(screen.getByText("Success output")).toBeTruthy();
    const resultDiv = screen.getByText("Success output");
    // Non-error tool results should NOT have error styling
    expect(resultDiv.className).not.toContain("text-cc-error");
  });

  it("renders Bash tool_result with last 20 lines and supports full output toggle", () => {
    const outputLines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n");
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-bash", name: "Bash", input: { command: "cat big.log" } },
        { type: "tool_result", tool_use_id: "tu-bash", content: outputLines },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Footer shows "last 20 of N" info text
    expect(screen.getByText(/last 20 of \d+/)).toBeTruthy();
    // Find the second pre (first is the command, second is the result)
    const allPres = document.querySelectorAll("pre");
    const resultPre = allPres[allPres.length - 1];
    const tailLines = (resultPre?.textContent || "").split("\n");
    expect(tailLines.includes("line-1")).toBe(false);
    expect(tailLines.includes("line-25")).toBe(true);

    // Click "Show all" to expand
    fireEvent.click(screen.getByText("Show all"));
    const allPresAfter = document.querySelectorAll("pre");
    const fullPre = allPresAfter[allPresAfter.length - 1];
    const fullLines = (fullPre?.textContent || "").split("\n");
    expect(fullLines.includes("line-1")).toBe(true);
    expect(screen.getByText("Show tail")).toBeTruthy();
  });
});

// ─── groupContentBlocks behavior (tested indirectly through MessageBubble) ──

describe("MessageBubble - content block grouping", () => {
  it("groups consecutive same-tool tool_use blocks together", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
        { type: "tool_use", id: "tu-3", name: "Read", input: { file_path: "/c.ts" } },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    // When grouped, there should be a count badge showing "3"
    expect(screen.getByText("3")).toBeTruthy();
    // The label should appear once (grouped)
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(1);
  });

  it("does not group different tool types together", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "ls" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Read renders as a card with label, Bash renders inline with command
    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.getByText("ls")).toBeTruthy();
  });

  it("renders a single tool_use without group count badge", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo hi" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Bash renders inline with the command visible, no count badge
    expect(screen.getByText("echo hi")).toBeTruthy();
    expect(screen.queryByText("1")).toBeNull();
  });

  it("groups same tools separated by non-tool blocks into separate groups", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "text", text: "Let me check something else" },
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // The two Read tools should not be grouped since there is a text block between them
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(2);
  });
});

// ─── Streaming phase rendering ──────────────────────────────────────────────

describe("MessageBubble - streaming", () => {
  it("renders thinking phase as ThinkingBlock during streaming", () => {
    // When isStreaming=true and streamingPhase="thinking", content should render as ThinkingBlock (italic)
    const msg = makeMessage({
      role: "assistant",
      content: "Analyzing the problem...",
      isStreaming: true,
      streamingPhase: "thinking",
    });
    const { container } = render(<MessageBubble message={msg} />);

    // ThinkingBlock renders with italic class
    const italicDiv = container.querySelector(".italic");
    expect(italicDiv).toBeTruthy();
    expect(screen.getByText("Analyzing the problem...")).toBeTruthy();
  });

  it("renders streaming text phase with a blinking cursor", () => {
    // When isStreaming=true and streamingPhase="text", a cursor element should appear
    const msg = makeMessage({
      role: "assistant",
      content: "Writing response...",
      isStreaming: true,
      streamingPhase: "text",
    });
    render(<MessageBubble message={msg} />);

    // The cursor is rendered via data-testid="assistant-stream-cursor"
    expect(screen.getByTestId("assistant-stream-cursor")).toBeTruthy();
    expect(screen.getByText("Writing response...")).toBeTruthy();
  });

  it("does not show cursor when not streaming", () => {
    // Non-streaming assistant message should not have a cursor
    const msg = makeMessage({
      role: "assistant",
      content: "Done.",
    });
    render(<MessageBubble message={msg} />);

    expect(screen.queryByTestId("assistant-stream-cursor")).toBeNull();
  });
});

// ─── ThinkingBlock edge cases ───────────────────────────────────────────────

describe("MessageBubble - ThinkingBlock", () => {
  it("renders null for empty thinking content", () => {
    // Claude Opus 4.7 returns thinking blocks with empty text + non-empty signature
    // by design (Anthropic docs: display defaults to "omitted"). The ThinkingBlock
    // should render nothing rather than a misleading "No thinking text captured."
    // fallback. We verify both that no fallback string appears and that the
    // ThinkingBlock's characteristic italic markdown wrapper is absent.
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: "   " },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    expect(screen.queryByText("No thinking text captured.")).toBeNull();
    // ThinkingBlock uses .markdown-body.italic as its wrapper — should not exist.
    expect(container.querySelector(".markdown-body.italic")).toBeNull();
  });

  it("does not show 'Show more' for short thinking content", () => {
    // Short text (fewer than 8 lines and under 600 chars) should not have a button
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: "Short thought." },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("triggers 'Show more' when thinking content exceeds 600 chars", () => {
    // isLong is true when normalized.length > 600 even with few lines
    const longText = "A".repeat(650);
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: longText },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Show more")).toBeTruthy();
  });
});

// ─── BashResultBlock edge cases ─────────────────────────────────────────────

describe("MessageBubble - BashResultBlock", () => {
  it("renders error BashResultBlock with error styling and 'Show all' toggle", () => {
    // Bash tool_result with is_error=true and many lines should show error styling
    const outputLines = Array.from({ length: 25 }, (_, i) => `error-line-${i + 1}`).join("\n");
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-err", name: "Bash", input: { command: "bad-cmd" } },
        { type: "tool_result", tool_use_id: "tu-err", content: outputLines, is_error: true },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    // Error styling applied to the pre element
    const errorPre = container.querySelector(".text-cc-error");
    expect(errorPre).toBeTruthy();

    // Footer counter text uses error styling class
    const footerSpan = screen.getByText(/last 20 of \d+/);
    expect(footerSpan).toBeTruthy();

    // Click "Show all" to expand
    fireEvent.click(screen.getByText("Show all"));
    // After expansion, footer shows total line count
    expect(screen.getByText(/25 lines/)).toBeTruthy();
    expect(screen.getByText("Show tail")).toBeTruthy();

    // Click "Show tail" to collapse back
    fireEvent.click(screen.getByText("Show tail"));
    expect(screen.getByText(/last 20 of 25/)).toBeTruthy();
  });

  it("renders short Bash output without toggle controls", () => {
    // Output with fewer than 20 lines should not show Show all / Show tail
    const shortOutput = "line1\nline2\nline3";
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-short", name: "Bash", input: { command: "ls" } },
        { type: "tool_result", tool_use_id: "tu-short", content: shortOutput },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.queryByText("Show all")).toBeNull();
    expect(screen.queryByText("Show tail")).toBeNull();
    expect(screen.getByText(/line1/)).toBeTruthy();
  });
});

// ─── ToolGroupBlock expand/collapse ─────────────────────────────────────────

describe("MessageBubble - ToolGroupBlock", () => {
  it("expands tool group on click to show individual items with preview", () => {
    // Create a group of 3 Read tools and verify expand reveals preview for each item
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-g1", name: "Read", input: { file_path: "/src/a.ts" } },
        { type: "tool_use", id: "tu-g2", name: "Read", input: { file_path: "/src/b.ts" } },
        { type: "tool_use", id: "tu-g3", name: "Read", input: { file_path: "/src/c.ts" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Group shows count badge "3"
    expect(screen.getByText("3")).toBeTruthy();

    // Click to expand the group
    fireEvent.click(screen.getByRole("button"));

    // Individual previews should be visible (getPreview for Read returns last 2 path segments)
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    expect(screen.getByText("src/c.ts")).toBeTruthy();
  });

  it("collapses tool group on second click", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-h1", name: "Grep", input: { pattern: "foo" } },
        { type: "tool_use", id: "tu-h2", name: "Grep", input: { pattern: "bar" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    const button = screen.getByRole("button");

    // Expand
    fireEvent.click(button);
    expect(screen.getByText("foo")).toBeTruthy();

    // Collapse
    fireEvent.click(button);
    expect(screen.queryByText("foo")).toBeNull();
  });

  it("renders tool group items with JSON fallback when no preview available", () => {
    // Tools with no getPreview match fall back to JSON.stringify of input
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-u1", name: "CustomTool", input: { key: "val" } },
        { type: "tool_use", id: "tu-u2", name: "CustomTool", input: { key: "val2" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Expand
    fireEvent.click(screen.getByRole("button"));
    // Fallback shows JSON.stringify(input).slice(0, 80)
    expect(screen.getByText(/{"key":"val"}/)).toBeTruthy();
  });
});

// ─── ContentBlockRenderer edge case ─────────────────────────────────────────

describe("MessageBubble - ContentBlockRenderer", () => {
  it("returns null for unknown content block types", () => {
    // Unknown block types should be silently ignored (render nothing)
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "text", text: "Known block" },
        // Force an unknown type via type assertion
        { type: "image" as "text", text: "" } as unknown as ContentBlock,
      ],
    });
    render(<MessageBubble message={msg} />);

    // The known text block renders, the unknown one does not crash
    expect(screen.getByText("Known block")).toBeTruthy();
  });

  it("renders tool_result linked to Bash tool_use as BashResultBlock", () => {
    // When tool_result is linked to a Bash tool_use via matching IDs, it renders as BashResultBlock
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-linked", name: "Bash", input: { command: "echo ok" } },
        { type: "tool_result", tool_use_id: "tu-linked", content: "ok" },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    // BashResultBlock wraps output in a rounded-lg bg-cc-code-bg div
    const resultContainers = container.querySelectorAll(".rounded-lg.bg-cc-code-bg");
    expect(resultContainers.length).toBeGreaterThan(0);
  });

  it("renders non-Bash tool_result as generic pre block (not BashResultBlock)", () => {
    // tool_result linked to non-Bash tool renders as plain pre, not BashResultBlock
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "/x" } },
        { type: "tool_result", tool_use_id: "tu-read", content: "file contents here" },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("file contents here")).toBeTruthy();
  });
});
