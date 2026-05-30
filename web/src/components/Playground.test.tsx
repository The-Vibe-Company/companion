// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import "vitest-axe/extend-expect";

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

  // UI-03 Task 13: the IdePicker section exists with its five mock states
  // plus the BIND-05 disconnect banner cell. This guards against anyone
  // accidentally removing the playground registration for /ide integration
  // components while refactoring.
  it("registers the IDE Picker section with all 5 states + BIND-05 banner", () => {
    render(<Playground />);
    // Section heading.
    expect(screen.getByText("IDE Picker")).toBeTruthy();
    const section = screen.getByTestId("playground-ide-picker-states");
    // The five preview states (cards labels are uppercased via CSS but the
    // literal text is stored as-is in the DOM; match on substrings).
    expect(within(section).getByText(/1\. Empty/)).toBeTruthy();
    expect(within(section).getByText(/2\. Single match/)).toBeTruthy();
    expect(within(section).getByText(/3\. Many IDEs with a best match/)).toBeTruthy();
    expect(within(section).getByText(/4\. Currently bound/)).toBeTruthy();
    expect(within(section).getByText(/5\. Bind failed/)).toBeTruthy();
    // BIND-05 banner copy must be present in the playground — the exact spec
    // string including em-dash. Duplicates the IdeDisconnectBanner test for
    // the "banner appears in the playground a11y scan" path.
    expect(
      within(section).getByText("IDE disconnected \u2014 rebind via /ide")
    ).toBeTruthy();
  });

  // Axe scan of just the new IDE Picker section. The full-Playground scan is
  // prohibitively slow; scoping keeps the test deterministic and fast while
  // still covering the new UI surface.
  it(
    "IDE Picker section has no axe violations",
    { timeout: 20000 },
    async () => {
      const { axe } = await import("vitest-axe");
      render(<Playground />);
      const section = screen.getByTestId("playground-ide-picker-states");
      const results = await axe(section);
      expect(results).toHaveNoViolations();
    }
  );
});
