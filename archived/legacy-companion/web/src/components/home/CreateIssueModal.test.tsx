// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockGetLinearStates = vi.fn();
const mockGetLinearConnection = vi.fn();
const mockCreateLinearIssue = vi.fn();

vi.mock("../../api.js", () => ({
  api: {
    getLinearStates: (...args: unknown[]) => mockGetLinearStates(...args),
    getLinearConnection: (...args: unknown[]) => mockGetLinearConnection(...args),
    createLinearIssue: (...args: unknown[]) => mockCreateLinearIssue(...args),
  },
}));

import { CreateIssueModal } from "./CreateIssueModal.js";

const sampleTeams = {
  teams: [
    {
      id: "team-1",
      key: "ENG",
      name: "Engineering",
      states: [
        { id: "state-backlog", name: "Backlog", type: "backlog" },
        { id: "state-inprogress", name: "In Progress", type: "started" },
        { id: "state-done", name: "Done", type: "completed" },
      ],
    },
    {
      id: "team-2",
      key: "DES",
      name: "Design",
      states: [
        { id: "state-backlog-2", name: "Backlog", type: "backlog" },
      ],
    },
  ],
};

const sampleConnection = {
  connected: true,
  viewerId: "viewer-123",
  viewerName: "Test User",
  viewerEmail: "test@example.com",
  teamName: "Engineering",
  teamKey: "ENG",
};

const sampleCreatedIssue = {
  ok: true,
  issue: {
    id: "issue-new",
    identifier: "ENG-42",
    title: "New Issue",
    description: "",
    url: "https://linear.app/team/issue/ENG-42",
    branchName: "eng-42-new-issue",
    priorityLabel: "No priority",
    stateName: "Backlog",
    stateType: "backlog",
    teamName: "Engineering",
    teamKey: "ENG",
    teamId: "team-1",
    assigneeName: "Test User",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLinearStates.mockResolvedValue(sampleTeams);
  mockGetLinearConnection.mockResolvedValue(sampleConnection);
  mockCreateLinearIssue.mockResolvedValue(sampleCreatedIssue);
});

describe("CreateIssueModal", () => {
  it("renders form fields after loading teams", async () => {
    // Verifies the modal renders title, description, team, priority inputs and action buttons.
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateIssueModal onCreated={onCreated} onClose={onClose} />);

    // Should show loading initially
    expect(screen.getByText("Loading teams...")).toBeInTheDocument();

    // After loading, form fields should appear
    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Team *")).toBeInTheDocument();
    expect(screen.getByLabelText("Priority")).toBeInTheDocument();
    expect(screen.getByLabelText("Assign to me")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Create Issue")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    // Validates the modal meets WCAG accessibility standards.
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<CreateIssueModal onCreated={onCreated} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    const { axe } = await import("vitest-axe");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("disables Create button when title is empty", async () => {
    // Verifies the submit button is disabled when the title input is empty.
    render(<CreateIssueModal onCreated={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    const createBtn = screen.getByText("Create Issue");
    expect(createBtn).toBeDisabled();
  });

  it("enables Create button when title is filled", async () => {
    // Verifies the submit button becomes enabled after typing a title.
    render(<CreateIssueModal onCreated={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Title *"), { target: { value: "My new issue" } });

    const createBtn = screen.getByText("Create Issue");
    expect(createBtn).not.toBeDisabled();
  });

  it("calls createLinearIssue with correct payload and invokes onCreated", async () => {
    // Verifies the full creation flow: filling out the form, clicking Create, and receiving the new issue.
    const onCreated = vi.fn();
    render(<CreateIssueModal onCreated={onCreated} onClose={vi.fn()} defaultProjectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Title *"), { target: { value: "Bug fix" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Fix the login bug" } });

    fireEvent.click(screen.getByText("Create Issue"));

    await waitFor(() => {
      expect(mockCreateLinearIssue).toHaveBeenCalledWith({
        title: "Bug fix",
        description: "Fix the login bug",
        teamId: "team-1",
        priority: 0,
        projectId: "proj-1",
        assigneeId: "viewer-123",
        stateId: "state-backlog",
        connectionId: undefined,
      });
    });

    expect(onCreated).toHaveBeenCalledWith(sampleCreatedIssue.issue);
  });

  it("threads connectionId through all API calls when provided", async () => {
    // Verifies that when a connectionId is passed, it's forwarded to getLinearStates,
    // getLinearConnection, and createLinearIssue so the correct Linear workspace is used.
    const connId = "conn-abc-123";
    const onCreated = vi.fn();
    render(
      <CreateIssueModal
        connectionId={connId}
        onCreated={onCreated}
        onClose={vi.fn()}
      />,
    );

    // Wait for teams to load — connectionId should be passed to both fetch calls
    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    expect(mockGetLinearStates).toHaveBeenCalledWith(connId);
    expect(mockGetLinearConnection).toHaveBeenCalledWith(connId);

    // Fill and submit the form
    fireEvent.change(screen.getByLabelText("Title *"), { target: { value: "Multi-conn issue" } });
    fireEvent.click(screen.getByText("Create Issue"));

    await waitFor(() => {
      expect(mockCreateLinearIssue).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: connId }),
      );
    });
  });

  it("shows error message when creation fails", async () => {
    // Verifies error feedback is displayed when the API call fails.
    mockCreateLinearIssue.mockRejectedValue(new Error("Network error"));

    render(<CreateIssueModal onCreated={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Title *"), { target: { value: "Test issue" } });
    fireEvent.click(screen.getByText("Create Issue"));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("calls onClose when Cancel is clicked", async () => {
    // Verifies the modal closes properly when the Cancel button is clicked.
    const onClose = vi.fn();
    render(<CreateIssueModal onCreated={vi.fn()} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop is clicked", async () => {
    // Verifies the modal closes when clicking the overlay behind the modal.
    const onClose = vi.fn();
    render(<CreateIssueModal onCreated={vi.fn()} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    // Click the backdrop (the outermost fixed div)
    const backdrop = screen.getByText("Create Linear Issue").closest(".fixed");
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("omits assigneeId when 'Assign to me' is unchecked", async () => {
    // Verifies that unchecking the assign checkbox removes the assigneeId from the API call.
    render(<CreateIssueModal onCreated={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Title *"), { target: { value: "Unassigned issue" } });
    fireEvent.click(screen.getByLabelText("Assign to me"));
    fireEvent.click(screen.getByText("Create Issue"));

    await waitFor(() => {
      expect(mockCreateLinearIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Unassigned issue",
          assigneeId: undefined,
        }),
      );
    });
  });

  it("shows error when teams fail to load", async () => {
    // Verifies error handling when the initial data fetch fails.
    mockGetLinearStates.mockRejectedValue(new Error("API unavailable"));

    render(<CreateIssueModal onCreated={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("API unavailable")).toBeInTheDocument();
    });
  });
});
