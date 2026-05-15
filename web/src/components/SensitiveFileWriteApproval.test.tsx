// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSensitiveWrite = vi.fn();
vi.mock("../api.js", () => ({
  api: {
    sensitiveWrite: (...args: unknown[]) => mockSensitiveWrite(...args),
  },
}));

const mockSendToSession = vi.fn();
vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

interface MockMsg {
  role?: string;
  contentBlocks?: Array<{ type: string; id?: string; input?: unknown }>;
}
interface MockStoreState {
  currentSessionId: string | null;
  messages: Map<string, MockMsg[]>;
}
let storeState: MockStoreState;
vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

import {
  SensitiveFileWriteApproval,
  isSensitiveFileRejection,
} from "./SensitiveFileWriteApproval.js";

const REJECTION_CONTENT =
  "Claude requested permissions to edit /home/foo/.claude/hooks/x.sh which is a sensitive file.";

const HISTORY_WITH_TOOL_USE: MockMsg[] = [
  {
    role: "assistant",
    contentBlocks: [
      {
        type: "tool_use",
        id: "tu-1",
        input: {
          file_path: "/home/foo/.claude/hooks/x.sh",
          content: "#!/bin/bash\necho hello",
        },
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  storeState = {
    currentSessionId: "s1",
    messages: new Map([["s1", HISTORY_WITH_TOOL_USE]]),
  };
});

describe("isSensitiveFileRejection", () => {
  it("matches the verbatim CLI rejection text", () => {
    // Anchor: we matched the canonical form the CLI emits today. Drift here
    // means the CLI rephrased its rejection — update the regex.
    expect(isSensitiveFileRejection(REJECTION_CONTENT)).toBe(true);
  });

  it("matches even with trailing whitespace", () => {
    expect(isSensitiveFileRejection(REJECTION_CONTENT + "  \n")).toBe(true);
  });

  it("does not match unrelated error strings", () => {
    expect(isSensitiveFileRejection("permission denied: /etc/passwd")).toBe(false);
    expect(isSensitiveFileRejection("Write failed: ENOENT")).toBe(false);
  });
});

describe("SensitiveFileWriteApproval", () => {
  it("renders the rejection text, file path, and content preview", () => {
    render(<SensitiveFileWriteApproval content={REJECTION_CONTENT} toolUseId="tu-1" />);
    expect(screen.getByText(REJECTION_CONTENT)).toBeInTheDocument();
    expect(screen.getByText("/home/foo/.claude/hooks/x.sh")).toBeInTheDocument();
    // Preview is in a <details> so the byte count shows; the content body
    // is in DOM but inside a collapsed disclosure.
    expect(screen.getByText(/Show pending content/i)).toBeInTheDocument();
  });

  it("Approve POSTs sensitiveWrite with the recovered file path + content", async () => {
    mockSensitiveWrite.mockResolvedValue({ ok: true, bytes_written: 22, path: "/home/foo/.claude/hooks/x.sh" });
    render(<SensitiveFileWriteApproval content={REJECTION_CONTENT} toolUseId="tu-1" />);
    fireEvent.click(screen.getByRole("button", { name: /approve and write/i }));

    await waitFor(() => {
      expect(mockSensitiveWrite).toHaveBeenCalledTimes(1);
    });
    expect(mockSensitiveWrite).toHaveBeenCalledWith("s1", {
      file_path: "/home/foo/.claude/hooks/x.sh",
      content: "#!/bin/bash\necho hello",
      tool_use_id: "tu-1",
    });
    await waitFor(() => {
      expect(screen.getByText(/Approved — file written/i)).toBeInTheDocument();
    });
  });

  it("Approve surfaces a server error inline (does not crash)", async () => {
    mockSensitiveWrite.mockRejectedValue(new Error("Write failed: ENOENT"));
    render(<SensitiveFileWriteApproval content={REJECTION_CONTENT} toolUseId="tu-1" />);
    fireEvent.click(screen.getByRole("button", { name: /approve and write/i }));

    await waitFor(() => {
      expect(screen.getByText(/Approval failed/i)).toBeInTheDocument();
      expect(screen.getByText(/Write failed: ENOENT/)).toBeInTheDocument();
    });
  });

  it("Reject sends a 'skip this file' user_message and disables the buttons", () => {
    render(<SensitiveFileWriteApproval content={REJECTION_CONTENT} toolUseId="tu-1" />);
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    expect(mockSendToSession).toHaveBeenCalledTimes(1);
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "user_message",
      content: expect.stringContaining("Skip writing /home/foo/.claude/hooks/x.sh"),
    });
    expect(screen.getByText(/Rejected — model will skip/i)).toBeInTheDocument();
  });

  it("Approve is disabled when the original tool_use cannot be found in history", () => {
    // E.g. user refreshed and we lost the assistant message — we still want
    // to show the card so the model's error is visible, but Approve has
    // nothing to write so it must be inert.
    storeState.messages.set("s1", []);
    render(<SensitiveFileWriteApproval content={REJECTION_CONTENT} toolUseId="tu-nonexistent" />);
    const approveBtn = screen.getByRole("button", { name: /approve and write/i });
    expect(approveBtn).toBeDisabled();
  });

  it("passes accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SensitiveFileWriteApproval content={REJECTION_CONTENT} toolUseId="tu-1" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
