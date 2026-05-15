// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const mockSendToSession = vi.fn();
vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

interface MockMessage {
  role?: string;
  content?: unknown;
  contentBlocks?: unknown;
}
interface MockSdkSession {
  sessionId: string;
  permissionMode?: string;
}
interface MockStoreState {
  currentSessionId: string | null;
  messages: Map<string, MockMessage[]>;
  sdkSessions: MockSdkSession[];
}
let storeState: MockStoreState;

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

import { ExitPlanModeToolBlock } from "./ExitPlanModeToolBlock.js";

beforeEach(() => {
  vi.clearAllMocks();
  storeState = {
    currentSessionId: "s1",
    messages: new Map(),
    sdkSessions: [{ sessionId: "s1", permissionMode: "plan" }],
  };
});

const PLAN_INPUT = {
  plan: "## Phase 0\n- Probe blacklister via etherscan\n- Capture sample tx",
};

describe("ExitPlanModeToolBlock", () => {
  it("renders the plan markdown content", () => {
    render(<ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-1" />);
    expect(screen.getByText("Phase 0")).toBeInTheDocument();
    // Plan card label from ExitPlanModeDisplay header.
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("Approve sends set_permission_mode + confirmation user_message when in plan mode", () => {
    // The session is in `--permission-mode plan`, so approving must flip
    // the mode to "default" so the CLI accepts subsequent file writes,
    // AND send a user_message so the model proceeds on the next turn.
    render(<ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-1" />);
    fireEvent.click(screen.getByRole("button", { name: /approve plan/i }));

    expect(mockSendToSession).toHaveBeenCalledTimes(2);
    expect(mockSendToSession).toHaveBeenNthCalledWith(1, "s1", {
      type: "set_permission_mode",
      mode: "default",
    });
    expect(mockSendToSession).toHaveBeenNthCalledWith(2, "s1", {
      type: "user_message",
      content: "Plan approved. Please proceed with the implementation.",
    });
  });

  it("Approve does NOT downgrade a non-plan session's permission mode", () => {
    // If the session is already in bypassPermissions / acceptEdits, sending
    // set_permission_mode "default" would unintentionally narrow privileges.
    // Only the user_message should fire.
    storeState.sdkSessions = [{ sessionId: "s1", permissionMode: "bypassPermissions" }];
    render(<ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-1" />);
    fireEvent.click(screen.getByRole("button", { name: /approve plan/i }));

    expect(mockSendToSession).toHaveBeenCalledTimes(1);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "user_message",
      content: "Plan approved. Please proceed with the implementation.",
    });
  });

  it("Reject sends only a revision-request user_message (no mode change)", () => {
    render(<ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-1" />);
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    expect(mockSendToSession).toHaveBeenCalledTimes(1);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "user_message",
      content: "Plan rejected — please revise the plan and present a new version.",
    });
  });

  it("hides the buttons after a user_message follows this tool_use in history", () => {
    // Mirror the AskUserQuestionToolBlock pattern — once the user has
    // responded once, refreshing the page should not let them respond again.
    // tool_use blocks live in contentBlocks (array), NOT content (string —
    // that's the extracted plain text). Regression for session dbb49e21
    // where stale 24-h-old plan cards kept the Approve buttons live because
    // the detector was reading the wrong field.
    storeState.messages.set("s1", [
      {
        role: "assistant",
        contentBlocks: [
          { type: "tool_use", id: "tu-2", name: "ExitPlanMode", input: PLAN_INPUT },
        ],
      },
      { role: "user", content: "Plan approved." },
    ]);

    render(<ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-2" />);
    expect(screen.queryByRole("button", { name: /approve plan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.getByText(/already responded/i)).toBeInTheDocument();
  });

  it("ignores tool_use blocks misplaced into the `content` field (regression: stale plan cards)", () => {
    // Defensive — make sure the detector specifically reads from
    // contentBlocks and does NOT fall back to reading `content` even if
    // some upstream code accidentally puts a tool_use there. Buttons must
    // stay live when the tool_use is in the wrong field (so the user can
    // still respond), but the tool_use *must* be found via contentBlocks
    // when it's there to actually disable.
    storeState.messages.set("s1", [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu-stale", name: "ExitPlanMode", input: PLAN_INPUT },
        ],
      },
      { role: "user", content: "Plan approved." },
    ]);
    render(<ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-stale" />);
    // No matching tool_use in contentBlocks → still interactive (regression
    // protection: if we ever broaden the lookup back to `content`, this
    // assertion catches it because it'd flip to "Already responded").
    expect(screen.getByRole("button", { name: /approve plan/i })).toBeInTheDocument();
  });

  it("does nothing when there is no current session id (stale render)", () => {
    // Defensive — after navigating home, currentSessionId can be null briefly
    // while a tool_use card lingers in a recycled component.
    storeState.currentSessionId = null;
    render(<ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-3" />);
    fireEvent.click(screen.getByRole("button", { name: /approve plan/i }));
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("passes accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <ExitPlanModeToolBlock input={PLAN_INPUT} toolUseId="tu-4" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Regression: in production, a 13.8 KB ExitPlanMode plan didn't render at
  // all in chat (user reported session fa6d5906 — model said "Waiting for
  // plan approval" but no card showed up). Load the actual failing payload
  // from the captured fixture and assert it renders end-to-end. If this
  // test fails the component crashes silently on real-world plan sizes.
  it("renders a real-world ~14 KB plan without crashing", () => {
    const FIXTURE_PATH = join(
      dirname(fileURLToPath(import.meta.url)),
      "__fixtures__",
      "large-exit-plan.md",
    );
    const realPlan = readFileSync(FIXTURE_PATH, "utf8");
    expect(realPlan.length).toBeGreaterThan(10_000);

    render(<ExitPlanModeToolBlock input={{ plan: realPlan }} toolUseId="tu-large" />);

    // Header chip from ExitPlanModeDisplay is always present.
    expect(screen.getByText("Plan")).toBeInTheDocument();
    // A distinctive line from the fixture's body — markdown is rendered as
    // HTML, so we look for the heading text the user would scan for.
    expect(screen.getByText(/per-tenant integrations/i)).toBeInTheDocument();
    // Approve / Reject buttons must be present (not pre-disabled).
    expect(screen.getByRole("button", { name: /approve plan/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });
});
