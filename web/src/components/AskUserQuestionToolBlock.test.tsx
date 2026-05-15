// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();
vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

interface MockMessage {
  role?: string;
  content?: unknown;
  contentBlocks?: unknown;
}
interface MockStoreState {
  currentSessionId: string | null;
  messages: Map<string, MockMessage[]>;
}
let storeState: MockStoreState;

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

import { AskUserQuestionToolBlock } from "./AskUserQuestionToolBlock.js";

beforeEach(() => {
  vi.clearAllMocks();
  storeState = {
    currentSessionId: "s1",
    messages: new Map(),
  };
});

const SINGLE_QUESTION = {
  questions: [
    {
      header: "Database",
      question: "Where do we store stablecoin events?",
      options: [
        { label: "Shared Postgres", description: "Reuse existing infra" },
        { label: "New DB", description: "Hard isolation" },
      ],
    },
  ],
};

const MULTI_QUESTION = {
  questions: [
    {
      header: "API",
      question: "One API or two?",
      options: [
        { label: "One", description: "" },
        { label: "Two", description: "" },
      ],
    },
    {
      header: "UI",
      question: "Shared package or split?",
      options: [
        { label: "Shared", description: "" },
        { label: "Split", description: "" },
      ],
    },
  ],
};

describe("AskUserQuestionToolBlock", () => {
  it("renders the question text and option labels", () => {
    render(<AskUserQuestionToolBlock input={SINGLE_QUESTION} toolUseId="tu-1" />);
    expect(screen.getByText("Where do we store stablecoin events?")).toBeInTheDocument();
    expect(screen.getByText("Shared Postgres")).toBeInTheDocument();
    expect(screen.getByText("New DB")).toBeInTheDocument();
    // Header chip uses the `header` field as a small badge.
    expect(screen.getByText("Database")).toBeInTheDocument();
  });

  it("clicking a single-question option auto-submits a user_message with just the label", () => {
    // Single-question mode auto-submits — no separate "Submit" button. The
    // formatted text is just the chosen label so the model reads it as a
    // direct answer to the prior AskUserQuestion call.
    render(<AskUserQuestionToolBlock input={SINGLE_QUESTION} toolUseId="tu-1" />);
    fireEvent.click(screen.getByText("Shared Postgres"));

    expect(mockSendToSession).toHaveBeenCalledTimes(1);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "user_message",
      content: "Shared Postgres",
    });
  });

  // Regression: a multi-question card used to show "Submit answers" as soon
  // as ONE option was clicked, sending a partial selections object back to
  // the model. The model then interpreted that as "the human answered all
  // questions" and proceeded with the missing answers blank. The user has
  // to answer every question before the submit button is offered.
  it("multi-question mode does NOT offer Submit while answers are incomplete", () => {
    render(<AskUserQuestionToolBlock input={MULTI_QUESTION} toolUseId="tu-partial" />);

    // Sanity check: with zero clicks the submit button must not be there.
    expect(screen.queryByRole("button", { name: /submit answers/i })).toBeNull();

    // Answer only the first of two questions.
    fireEvent.click(screen.getByText("Two"));

    // Submit must still not appear — the second question is unanswered.
    expect(screen.queryByRole("button", { name: /submit answers/i })).toBeNull();
    // And of course nothing was sent to the session.
    expect(mockSendToSession).not.toHaveBeenCalled();

    // Finish the second question — now Submit appears.
    fireEvent.click(screen.getByText("Split"));
    expect(screen.getByRole("button", { name: /submit answers/i })).toBeInTheDocument();
  });

  it("multi-question mode requires Submit and labels each line with the question header", () => {
    // For multi-question we keep the question header alongside each label so
    // the model can disambiguate which answer maps to which question.
    render(<AskUserQuestionToolBlock input={MULTI_QUESTION} toolUseId="tu-2" />);
    fireEvent.click(screen.getByText("Two"));
    fireEvent.click(screen.getByText("Split"));

    // Auto-submit should NOT have fired for multi-question.
    expect(mockSendToSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));

    expect(mockSendToSession).toHaveBeenCalledTimes(1);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "user_message",
      content: "- API: Two\n- UI: Split",
    });
  });

  it("becomes non-interactive once a user_message follows the same tool_use in history", () => {
    // The Composer / model will eventually persist the user's answer as a
    // user-role message. After that, clicking the original card again would
    // double-answer. Detect the trailing user message and lock the card.
    storeState.messages.set("s1", [
      // The assistant message whose contentBlocks array contains the
      // AskUserQuestion tool_use we're rendering. ChatMessage shape:
      // `content` is the extracted plain text, `contentBlocks` is the
      // structured array (mirroring the CLI's message.content). The
      // alreadyAnswered detector reads contentBlocks.
      {
        role: "assistant",
        contentBlocks: [
          { type: "tool_use", id: "tu-3", name: "AskUserQuestion", input: SINGLE_QUESTION },
        ],
      },
      // User already replied once.
      { role: "user", content: "Shared Postgres" },
    ]);

    render(<AskUserQuestionToolBlock input={SINGLE_QUESTION} toolUseId="tu-3" />);
    expect(screen.getByText("Question answered")).toBeInTheDocument();

    // All the option buttons should be disabled.
    const button = screen.getByRole("button", { name: /Shared Postgres/i });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does nothing when there is no current session id", () => {
    // Edge case: a stale render after the user navigated home. We must not
    // crash and must not blast the message at the wrong session.
    storeState.currentSessionId = null;
    render(<AskUserQuestionToolBlock input={SINGLE_QUESTION} toolUseId="tu-4" />);
    fireEvent.click(screen.getByText("Shared Postgres"));
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("passes accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <AskUserQuestionToolBlock input={SINGLE_QUESTION} toolUseId="tu-5" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
