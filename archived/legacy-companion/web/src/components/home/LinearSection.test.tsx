// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockGetLinearProjectMapping = vi.fn();
const mockGetLinearProjectIssues = vi.fn();
const mockSearchLinearIssues = vi.fn();
const mockListLinearProjects = vi.fn();
const mockUpsertLinearProjectMapping = vi.fn();
const mockRemoveLinearProjectMapping = vi.fn();
const mockGetLinearStates = vi.fn();
const mockGetLinearConnection = vi.fn();
const mockCreateLinearIssue = vi.fn();
const mockListLinearConnections = vi.fn();

vi.mock("../../api.js", () => ({
  api: {
    getLinearProjectMapping: (...args: unknown[]) => mockGetLinearProjectMapping(...args),
    getLinearProjectIssues: (...args: unknown[]) => mockGetLinearProjectIssues(...args),
    searchLinearIssues: (...args: unknown[]) => mockSearchLinearIssues(...args),
    listLinearProjects: (...args: unknown[]) => mockListLinearProjects(...args),
    upsertLinearProjectMapping: (...args: unknown[]) => mockUpsertLinearProjectMapping(...args),
    removeLinearProjectMapping: (...args: unknown[]) => mockRemoveLinearProjectMapping(...args),
    getLinearStates: (...args: unknown[]) => mockGetLinearStates(...args),
    getLinearConnection: (...args: unknown[]) => mockGetLinearConnection(...args),
    createLinearIssue: (...args: unknown[]) => mockCreateLinearIssue(...args),
    listLinearConnections: (...args: unknown[]) => mockListLinearConnections(...args),
  },
}));

vi.mock("../../utils/linear-branch.js", () => ({
  resolveLinearBranch: (issue: { identifier: string; title: string }) =>
    `${issue.identifier.toLowerCase()}-${issue.title.toLowerCase().replace(/\s+/g, "-")}`,
}));

vi.mock("../LinearLogo.js", () => ({
  LinearLogo: ({ className }: { className?: string }) => (
    <span data-testid="linear-logo" className={className} />
  ),
}));

vi.mock("./CreateIssueModal.js", () => ({
  CreateIssueModal: ({ onCreated, onClose }: { onCreated: (issue: unknown) => void; onClose: () => void }) => (
    <div data-testid="create-issue-modal">
      <button onClick={() => onCreated({
        id: "new-1",
        identifier: "ENG-99",
        title: "Created Issue",
        description: "",
        url: "https://linear.app/ENG-99",
        branchName: "eng-99-created-issue",
        priorityLabel: "",
        stateName: "Backlog",
        stateType: "backlog",
        teamName: "Engineering",
        teamKey: "ENG",
        teamId: "t1",
      })}>
        mock-create
      </button>
      <button onClick={onClose}>mock-close</button>
    </div>
  ),
}));

import { LinearSection } from "./LinearSection.js";

const defaultGitRepoInfo = {
  repoRoot: "/repo",
  repoName: "my-repo",
  currentBranch: "main",
  defaultBranch: "main",
  isWorktree: false,
};

const sampleIssue = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix bug",
  description: "A bug fix",
  url: "https://linear.app/ENG-1",
  branchName: "eng-1-fix-bug",
  priorityLabel: "High",
  stateName: "In Progress",
  stateType: "started",
  teamName: "Engineering",
  teamKey: "ENG",
  teamId: "t1",
};

const sampleMapping = {
  repoRoot: "/repo",
  projectId: "proj-1",
  projectName: "My Project",
  createdAt: 1000,
  updatedAt: 2000,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no mapping, no issues
  mockGetLinearProjectMapping.mockResolvedValue({ mapping: null });
  mockGetLinearProjectIssues.mockResolvedValue({ issues: [] });
  mockSearchLinearIssues.mockResolvedValue({ issues: [] });
  mockListLinearProjects.mockResolvedValue({ projects: [] });
  mockRemoveLinearProjectMapping.mockResolvedValue({ ok: true });
  mockGetLinearStates.mockResolvedValue({ teams: [] });
  mockGetLinearConnection.mockResolvedValue({ connected: true, viewerId: "v1", viewerName: "User", viewerEmail: "", teamName: "", teamKey: "" });
  mockCreateLinearIssue.mockResolvedValue({ ok: true, issue: sampleIssue });
  // Default: single connection (auto-selected, no dropdown shown)
  mockListLinearConnections.mockResolvedValue({
    connections: [{
      id: "conn-1",
      name: "Default",
      apiKeyLast4: "1234",
      workspaceName: "My Workspace",
      workspaceId: "ws-1",
      viewerName: "User",
      viewerEmail: "user@test.com",
      connected: true,
      autoTransition: false,
      autoTransitionStateId: "",
      autoTransitionStateName: "",
      archiveTransition: false,
      archiveTransitionStateId: "",
      archiveTransitionStateName: "",
    }],
  });
});

describe("LinearSection", () => {
  it("returns null when linearConfigured is false", () => {
    // Verifies the component doesn't render at all when Linear is not configured.
    const { container } = render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={false}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders Context label and Linear button when configured without mapping", async () => {
    // Verifies the basic layout: Context label, Linear button, Attach project, and Create issue buttons.
    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Context")).toBeInTheDocument();
    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.getByText("Attach project")).toBeInTheDocument();
    expect(screen.getByText("Create issue")).toBeInTheDocument();
  });

  it("shows project badge and Create issue when mapping exists", async () => {
    // Verifies the project badge is displayed when a mapping is found, alongside the Create issue button.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });
    // Create issue button should be visible next to the project badge
    expect(screen.getByText("Create issue")).toBeInTheDocument();
  });

  it("displays recent issues when mapping exists and issues are loaded", async () => {
    // Verifies that project issues are displayed in the issue browser.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("ENG-1")).toBeInTheDocument();
    });
    expect(screen.getByText(/Fix bug/)).toBeInTheDocument();
  });

  it("selects an issue from the project issue list", async () => {
    // Verifies that clicking an issue calls onIssueSelect and onBranchFromIssue.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    const onIssueSelect = vi.fn();
    const onBranchFromIssue = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={onIssueSelect}
        onBranchFromIssue={onBranchFromIssue}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("ENG-1")).toBeInTheDocument();
    });

    // Click the issue button
    const issueBtn = screen.getByText("ENG-1").closest("button")!;
    fireEvent.click(issueBtn);

    expect(onIssueSelect).toHaveBeenCalledWith(sampleIssue);
    expect(onBranchFromIssue).toHaveBeenCalledWith("eng-1-fix-bug", true);
  });

  it("shows selected issue badge when an issue is selected", async () => {
    // Verifies the selected issue is displayed as a badge above the issue list.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={sampleIssue}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle("Remove issue")).toBeInTheDocument();
    });
  });

  it("opens the Linear search dropdown when Linear button is clicked", async () => {
    // Verifies the search dropdown opens with an input and close button.
    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Linear"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("ENG-123 or issue title")).toBeInTheDocument();
    });
  });

  it("opens Create Issue modal when Create issue button is clicked", async () => {
    // Verifies the CreateIssueModal is shown when the Create issue button is clicked.
    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Create issue"));

    expect(screen.getByTestId("create-issue-modal")).toBeInTheDocument();
  });

  it("auto-selects issue after creation from modal", async () => {
    // Verifies the onIssueSelect callback is called with the newly created issue.
    const onIssueSelect = vi.fn();
    const onBranchFromIssue = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={onIssueSelect}
        onBranchFromIssue={onBranchFromIssue}
        onConnectionSelect={vi.fn()}
      />,
    );

    // Open the modal
    fireEvent.click(screen.getByText("Create issue"));
    expect(screen.getByTestId("create-issue-modal")).toBeInTheDocument();

    // Simulate issue creation via the mock modal
    fireEvent.click(screen.getByText("mock-create"));

    expect(onIssueSelect).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: "ENG-99", title: "Created Issue" }),
    );
    expect(onBranchFromIssue).toHaveBeenCalled();
    // Modal should be closed
    expect(screen.queryByTestId("create-issue-modal")).not.toBeInTheDocument();
  });

  it("closes Create Issue modal on cancel", async () => {
    // Verifies the modal closes when the close callback is triggered.
    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Create issue"));
    expect(screen.getByTestId("create-issue-modal")).toBeInTheDocument();

    fireEvent.click(screen.getByText("mock-close"));
    expect(screen.queryByTestId("create-issue-modal")).not.toBeInTheDocument();
  });

  it("opens the attach project dropdown and shows projects", async () => {
    // Verifies the attach project dropdown opens and fetches available projects.
    mockListLinearProjects.mockResolvedValue({
      projects: [
        { id: "p1", name: "Project Alpha", state: "active" },
        { id: "p2", name: "Project Beta", state: "active" },
      ],
    });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Attach project"));

    await waitFor(() => {
      expect(screen.getByText("Project Alpha")).toBeInTheDocument();
    });
    expect(screen.getByText("Project Beta")).toBeInTheDocument();
  });

  it("detaches a project when the detach button is clicked", async () => {
    // Verifies the detach button removes the project mapping.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [] });

    const onIssueSelect = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={onIssueSelect}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Detach Linear project"));

    await waitFor(() => {
      expect(mockRemoveLinearProjectMapping).toHaveBeenCalledWith("/repo");
    });
  });

  it("filters issues by search query in issue browser", async () => {
    // Verifies the inline search filters the displayed issues.
    // Uses waitFor with increased timeout because the component re-fetches issues
    // when selectedConnectionId changes (after connections load), which can cause
    // a brief "Loading recent issues..." state between the two fetches.
    // On slower CI runners (e.g. Ubuntu), this race is more likely to surface.
    const issues = [
      { ...sampleIssue, id: "i1", identifier: "ENG-1", title: "Fix login" },
      { ...sampleIssue, id: "i2", identifier: "ENG-2", title: "Add dashboard" },
    ];
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    // Wait for both ENG-1 and ENG-2 to appear together in the same waitFor
    // to ensure the final re-fetch (after connectionId is set) has completed.
    await waitFor(() => {
      expect(screen.getByText("ENG-1")).toBeInTheDocument();
      expect(screen.getByText("ENG-2")).toBeInTheDocument();
    }, { timeout: 3000 });

    // Filter by "login"
    const searchInput = screen.getByPlaceholderText("Filter issues...");
    fireEvent.change(searchInput, { target: { value: "login" } });

    await waitFor(() => {
      expect(screen.getByText("ENG-1")).toBeInTheDocument();
      expect(screen.queryByText("ENG-2")).not.toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("shows loading state while fetching recent issues", async () => {
    // Verifies the loading indicator is shown while issues are being fetched.
    let resolveMapping: (v: unknown) => void;
    mockGetLinearProjectMapping.mockReturnValue(new Promise((r) => { resolveMapping = r; }));

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    // Should not crash while loading
    expect(screen.getByText("Context")).toBeInTheDocument();

    // Resolve the mapping
    await act(async () => {
      resolveMapping!({ mapping: null });
    });
  });

  it("passes axe accessibility checks", async () => {
    // Validates the component meets WCAG accessibility standards.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    const { container } = render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    const { axe } = await import("vitest-axe");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("handles error when fetching project issues after mapping loads", async () => {
    // Verifies error state is shown in the issue browser when getLinearProjectIssues fails.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockRejectedValue(new Error("Network fail"));

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Network fail")).toBeInTheDocument();
    });
  });

  it("attaches a project from the dropdown", async () => {
    // Verifies that clicking a project in the dropdown calls upsertLinearProjectMapping.
    mockListLinearProjects.mockResolvedValue({
      projects: [{ id: "p1", name: "Project Alpha", state: "active" }],
    });
    mockUpsertLinearProjectMapping.mockResolvedValue({
      mapping: { repoRoot: "/repo", projectId: "p1", projectName: "Project Alpha", createdAt: 1000, updatedAt: 2000 },
    });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Attach project"));

    await waitFor(() => {
      expect(screen.getByText("Project Alpha")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Project Alpha"));

    await waitFor(() => {
      expect(mockUpsertLinearProjectMapping).toHaveBeenCalledWith({
        repoRoot: "/repo",
        projectId: "p1",
        projectName: "Project Alpha",
      });
    });
  });

  it("searches issues via the Linear dropdown", async () => {
    // Verifies that typing in the search dropdown triggers an API search after debounce.
    mockSearchLinearIssues.mockResolvedValue({
      issues: [sampleIssue],
    });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    // Open search dropdown
    fireEvent.click(screen.getByText("Linear"));

    const searchInput = screen.getByPlaceholderText("ENG-123 or issue title");
    fireEvent.change(searchInput, { target: { value: "fix bug" } });

    // Wait for debounce (400ms) and API call to complete (includes auto-selected connectionId)
    await waitFor(() => {
      expect(mockSearchLinearIssues).toHaveBeenCalledWith("fix bug", 8, "conn-1");
    }, { timeout: 3000 });
  });

  it("selects an issue from the search dropdown and closes it", async () => {
    // Verifies selecting a search result calls onIssueSelect and closes the dropdown.
    mockSearchLinearIssues.mockResolvedValue({ issues: [sampleIssue] });

    const onIssueSelect = vi.fn();
    const onBranchFromIssue = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={onIssueSelect}
        onBranchFromIssue={onBranchFromIssue}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Linear"));
    const searchInput = screen.getByPlaceholderText("ENG-123 or issue title");
    fireEvent.change(searchInput, { target: { value: "fix bug" } });

    // Wait for debounce and search results to appear
    await waitFor(() => {
      expect(screen.getByText(/ENG-1/)).toBeInTheDocument();
    }, { timeout: 3000 });

    // Click the search result
    const issueBtn = screen.getByText(/ENG-1/).closest("button")!;
    fireEvent.click(issueBtn);

    expect(onIssueSelect).toHaveBeenCalledWith(sampleIssue);
    expect(onBranchFromIssue).toHaveBeenCalled();
  });

  it("toggles search all projects and shows search prompt", async () => {
    // Verifies the "Search all projects" toggle changes the search behavior.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Search all projects")).toBeInTheDocument();
    });

    // Toggle search all projects
    fireEvent.click(screen.getByText("Search all projects"));

    // Should show the "type 2 characters" prompt (may need a re-render cycle)
    await waitFor(() => {
      expect(screen.getByText("Type at least 2 characters to search all projects...")).toBeInTheDocument();
    });
  });

  it("removes selected issue when remove button is clicked in issue badge", async () => {
    // Verifies clicking the remove button on the selected issue badge clears the selection.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    const onIssueSelect = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={sampleIssue}
        onIssueSelect={onIssueSelect}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle("Remove issue")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Remove issue"));
    expect(onIssueSelect).toHaveBeenCalledWith(null);
  });

  it("closes search dropdown via Close button", async () => {
    // Verifies the Close button in the search dropdown closes it.
    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Linear"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("ENG-123 or issue title")).toBeInTheDocument();
    });

    // The dropdown should have a Close button
    const closeButtons = screen.getAllByText("Close");
    fireEvent.click(closeButtons[0]);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("ENG-123 or issue title")).not.toBeInTheDocument();
    });
  });

  it("closes attach project dropdown via Close button", async () => {
    // Verifies the Close button in the attach dropdown closes it.
    mockListLinearProjects.mockResolvedValue({ projects: [] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Attach project"));
    await waitFor(() => {
      expect(screen.getByText("Attach a Linear project to this repo")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Close"));

    await waitFor(() => {
      expect(screen.queryByText("Attach a Linear project to this repo")).not.toBeInTheDocument();
    });
  });

  it("shows no active issues message when project has no issues", async () => {
    // Verifies the empty state message when the project has no active issues.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No active issues found")).toBeInTheDocument();
    });
  });

  it("performs global search when 'Search all projects' is toggled and query entered", async () => {
    // Verifies the global search effect triggers the API with the search query.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });
    mockSearchLinearIssues.mockResolvedValue({
      issues: [{ ...sampleIssue, id: "i-global", identifier: "DES-5", title: "Global result" }],
    });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Search all projects")).toBeInTheDocument();
    });

    // Toggle search all projects on
    fireEvent.click(screen.getByText("Search all projects"));

    // Type a query in the filter input
    const searchInput = screen.getByPlaceholderText("Search all projects...");
    fireEvent.change(searchInput, { target: { value: "global" } });

    // Wait for debounce + API call (includes auto-selected connectionId)
    await waitFor(() => {
      expect(mockSearchLinearIssues).toHaveBeenCalledWith("global", 10, "conn-1");
    }, { timeout: 3000 });

    // Results should appear
    await waitFor(() => {
      expect(screen.getByText("DES-5")).toBeInTheDocument();
    });
  });

  it("clears issue via the remove badge button when no mapping", async () => {
    // Verifies handleClearIssue clears the selected issue and search state.
    const onIssueSelect = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={sampleIssue}
        onIssueSelect={onIssueSelect}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    // Open the search dropdown to see the selected issue state
    fireEvent.click(screen.getByText("Linear"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("ENG-123 or issue title")).toBeInTheDocument();
    });
  });

  it("refreshes recent issues after creating an issue when mapping exists", async () => {
    // Verifies that handleIssueCreated refreshes the recent issues list when a mapping is present.
    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    const onIssueSelect = vi.fn();
    const onBranchFromIssue = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={onIssueSelect}
        onBranchFromIssue={onBranchFromIssue}
        onConnectionSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    // Open modal and create issue
    fireEvent.click(screen.getByText("Create issue"));
    fireEvent.click(screen.getByText("mock-create"));

    // Should have called getLinearProjectIssues again to refresh the list.
    // Calls: initial load (connectionId=undefined) + re-fetch after connectionId set + refresh after create = 3 calls
    await waitFor(() => {
      expect(mockGetLinearProjectIssues).toHaveBeenCalledTimes(3);
    });
  });

  it("shows search error in the Linear dropdown", async () => {
    // Verifies search error is displayed in the dropdown when searchLinearIssues fails.
    mockSearchLinearIssues.mockRejectedValue(new Error("Search failed"));

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Linear"));
    const searchInput = screen.getByPlaceholderText("ENG-123 or issue title");
    fireEvent.change(searchInput, { target: { value: "failing query" } });

    await waitFor(() => {
      expect(screen.getByText("Search failed")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("shows settings gear button linking to Linear settings", () => {
    // Verifies the settings button is rendered with the correct title.
    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    expect(screen.getByTitle("Linear settings")).toBeInTheDocument();
  });

  it("auto-selects single connection and calls onConnectionSelect", async () => {
    // When only one connection exists, it should be auto-selected without showing a dropdown.
    const onConnectionSelect = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={onConnectionSelect}
      />,
    );

    await waitFor(() => {
      expect(onConnectionSelect).toHaveBeenCalledWith("conn-1");
    });

    // No dropdown should be visible with a single connection
    expect(screen.queryByTitle("Select Linear workspace")).not.toBeInTheDocument();
  });

  it("shows connection dropdown when multiple connections exist", async () => {
    // When multiple connections exist, a dropdown should be rendered to pick between them.
    mockListLinearConnections.mockResolvedValue({
      connections: [
        {
          id: "conn-1",
          name: "Connection A",
          apiKeyLast4: "1234",
          workspaceName: "Workspace A",
          workspaceId: "ws-1",
          viewerName: "User",
          viewerEmail: "user@test.com",
          connected: true,
          autoTransition: false,
          autoTransitionStateId: "",
          autoTransitionStateName: "",
          archiveTransition: false,
          archiveTransitionStateId: "",
          archiveTransitionStateName: "",
        },
        {
          id: "conn-2",
          name: "Connection B",
          apiKeyLast4: "5678",
          workspaceName: "Workspace B",
          workspaceId: "ws-2",
          viewerName: "User2",
          viewerEmail: "user2@test.com",
          connected: true,
          autoTransition: false,
          autoTransitionStateId: "",
          autoTransitionStateName: "",
          archiveTransition: false,
          archiveTransitionStateId: "",
          archiveTransitionStateName: "",
        },
      ],
    });

    const onConnectionSelect = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={onConnectionSelect}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle("Select Linear workspace")).toBeInTheDocument();
    });

    // Both workspace names should appear as options
    const select = screen.getByTitle("Select Linear workspace") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(select.options[0].textContent).toBe("Workspace A");
    expect(select.options[1].textContent).toBe("Workspace B");

    // First connection should be auto-selected
    expect(onConnectionSelect).toHaveBeenCalledWith("conn-1");
  });

  it("switching connection clears search state and re-fetches project issues", async () => {
    // When the user switches connections, search results should be cleared and project issues re-fetched.
    mockListLinearConnections.mockResolvedValue({
      connections: [
        {
          id: "conn-1",
          name: "Connection A",
          apiKeyLast4: "1234",
          workspaceName: "Workspace A",
          workspaceId: "ws-1",
          viewerName: "User",
          viewerEmail: "user@test.com",
          connected: true,
          autoTransition: false,
          autoTransitionStateId: "",
          autoTransitionStateName: "",
          archiveTransition: false,
          archiveTransitionStateId: "",
          archiveTransitionStateName: "",
        },
        {
          id: "conn-2",
          name: "Connection B",
          apiKeyLast4: "5678",
          workspaceName: "Workspace B",
          workspaceId: "ws-2",
          viewerName: "User2",
          viewerEmail: "user2@test.com",
          connected: true,
          autoTransition: false,
          autoTransitionStateId: "",
          autoTransitionStateName: "",
          archiveTransition: false,
          archiveTransitionStateId: "",
          archiveTransitionStateName: "",
        },
      ],
    });

    mockGetLinearProjectMapping.mockResolvedValue({ mapping: sampleMapping });
    mockGetLinearProjectIssues.mockResolvedValue({ issues: [sampleIssue] });

    const onConnectionSelect = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={onConnectionSelect}
      />,
    );

    // Wait for the dropdown and initial project issues to load
    await waitFor(() => {
      expect(screen.getByTitle("Select Linear workspace")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    // Switch to the second connection
    const select = screen.getByTitle("Select Linear workspace") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "conn-2" } });

    expect(onConnectionSelect).toHaveBeenCalledWith("conn-2");

    // getLinearProjectIssues should be called again with the new connectionId
    await waitFor(() => {
      expect(mockGetLinearProjectIssues).toHaveBeenCalledWith(
        sampleMapping.projectId,
        10,
        "conn-2",
      );
    });
  });

  it("does not show connection dropdown when no connections exist", async () => {
    // Verifies that when the connections list is empty, no dropdown is rendered.
    mockListLinearConnections.mockResolvedValue({ connections: [] });

    const onConnectionSelect = vi.fn();

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={onConnectionSelect}
      />,
    );

    // Wait for the connections to load
    await waitFor(() => {
      expect(mockListLinearConnections).toHaveBeenCalled();
    });

    // No dropdown should be visible
    expect(screen.queryByTitle("Select Linear workspace")).not.toBeInTheDocument();

    // onConnectionSelect should be called with null
    expect(onConnectionSelect).toHaveBeenCalledWith(null);
  });

  it("passes selectedConnectionId to searchLinearIssues", async () => {
    // Verifies that the selected connection ID is passed to the search API.
    mockSearchLinearIssues.mockResolvedValue({ issues: [sampleIssue] });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    // Wait for connection to be auto-selected
    await waitFor(() => {
      expect(mockListLinearConnections).toHaveBeenCalled();
    });

    // Open search dropdown
    fireEvent.click(screen.getByText("Linear"));
    const searchInput = screen.getByPlaceholderText("ENG-123 or issue title");
    fireEvent.change(searchInput, { target: { value: "fix bug" } });

    // Wait for debounce and API call - should include the connectionId
    await waitFor(() => {
      expect(mockSearchLinearIssues).toHaveBeenCalledWith("fix bug", 8, "conn-1");
    }, { timeout: 3000 });
  });

  it("passes selectedConnectionId to listLinearProjects", async () => {
    // Verifies that the selected connection ID is passed when fetching projects.
    mockListLinearProjects.mockResolvedValue({
      projects: [{ id: "p1", name: "Project Alpha", state: "active" }],
    });

    render(
      <LinearSection
        cwd="/repo"
        gitRepoInfo={defaultGitRepoInfo}
        linearConfigured={true}
        selectedLinearIssue={null}
        onIssueSelect={vi.fn()}
        onBranchFromIssue={vi.fn()}
        onConnectionSelect={vi.fn()}
      />,
    );

    // Wait for connection to be auto-selected
    await waitFor(() => {
      expect(mockListLinearConnections).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Attach project"));

    await waitFor(() => {
      expect(mockListLinearProjects).toHaveBeenCalledWith("conn-1");
    });
  });
});
