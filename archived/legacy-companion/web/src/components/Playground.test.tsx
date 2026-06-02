// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock markdown renderer used by MessageBubble/PermissionBanner
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

import { Playground } from "./Playground.js";

describe("Playground", () => {
  it("renders the real chat stack section with integrated chat components", () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();

    // Dynamic tool permission should be visible inside the integrated ChatView.
    expect(within(realChat).getByText("dynamic:code_interpreter")).toBeTruthy();

    // Subagent playground demo should show Codex-specific metadata presentation.
    expect(screen.getByText("sender: thr_main")).toBeTruthy();
    expect(screen.getByText("thr_sub_1")).toBeTruthy();

    // Interesting event states should be represented in the playground.
    expect(screen.getByText("Interesting Events")).toBeTruthy();
    expect(screen.getByText("Context compacted (auto, pre-tokens: 182344).")).toBeTruthy();
    expect(screen.getByText("Hook success: lint (post_tool_use) (exit 0).")).toBeTruthy();
  });
});
