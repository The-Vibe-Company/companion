// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  currentSessionId: string | null;
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: Array<{ sessionId: string; cwd: string }>;
}

let mockState: MockStoreState;

const mockApi = {
  listPrompts: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(),
  listDirs: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    listPrompts: (...args: unknown[]) => mockApi.listPrompts(...args),
    createPrompt: (...args: unknown[]) => mockApi.createPrompt(...args),
    updatePrompt: (...args: unknown[]) => mockApi.updatePrompt(...args),
    deletePrompt: (...args: unknown[]) => mockApi.deletePrompt(...args),
    listDirs: (...args: unknown[]) => mockApi.listDirs(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

// Mock createPortal for FolderPicker
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

import { PromptsPage } from "./PromptsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = {
    currentSessionId: "s1",
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
  };
  mockApi.listPrompts.mockResolvedValue([]);
  mockApi.createPrompt.mockResolvedValue({
    id: "p1",
    name: "review-pr",
    content: "Review this PR",
    scope: "global",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  mockApi.updatePrompt.mockResolvedValue({
    id: "p1",
    name: "updated",
    content: "Updated prompt content",
    scope: "global",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  mockApi.deletePrompt.mockResolvedValue({ ok: true });
  mockApi.listDirs.mockResolvedValue({ path: "/", dirs: [], home: "/" });
});

describe("PromptsPage", () => {
  it("loads all prompts on mount without session cwd filtering", async () => {
    // Validates prompt listing fetches all prompts regardless of active session cwd.
    render(<PromptsPage embedded />);
    await waitFor(() => {
      expect(mockApi.listPrompts).toHaveBeenCalledWith();
    });
  });

  it("creates a global prompt by default", async () => {
    // Validates create payload defaults to global scope.
    render(<PromptsPage embedded />);
    fireEvent.click(screen.getByRole("button", { name: /new prompt/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "review-pr" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Review this PR" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    await waitFor(() => {
      expect(mockApi.createPrompt).toHaveBeenCalledWith({
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
      });
    });
  });

  it("creates a project-scoped prompt with cwd pre-filled", async () => {
    // Validates clicking "Project folders" scope sets projectPaths from cwd.
    render(<PromptsPage embedded />);
    fireEvent.click(screen.getByRole("button", { name: /new prompt/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "project-prompt" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Project content" } });

    // Switch to project scope
    fireEvent.click(screen.getByRole("button", { name: "Project folders" }));

    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    await waitFor(() => {
      expect(mockApi.createPrompt).toHaveBeenCalledWith({
        name: "project-prompt",
        content: "Project content",
        scope: "project",
        projectPaths: ["/repo"],
      });
    });
  });

  it("can create a global prompt without cwd", async () => {
    // Edge case: creation should work with no active session in global-only mode.
    mockState = {
      currentSessionId: null,
      sessions: new Map(),
      sdkSessions: [],
    };
    render(<PromptsPage embedded />);
    fireEvent.click(screen.getByRole("button", { name: /new prompt/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "global" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "Always do X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    await waitFor(() => {
      expect(mockApi.createPrompt).toHaveBeenCalledWith({
        name: "global",
        content: "Always do X",
        scope: "global",
      });
    });
  });

  it("deletes an existing prompt", async () => {
    // Validates delete action wiring from list item to API.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("review-pr");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockApi.deletePrompt).toHaveBeenCalledWith("p1");
    });
  });

  it("edits an existing prompt", async () => {
    // Validates inline edit mode persists name, content, scope through updatePrompt.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("review-pr");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const nameInput = screen.getByDisplayValue("review-pr");
    const contentInput = screen.getByDisplayValue("Review this PR");
    fireEvent.change(nameInput, { target: { value: "review-updated" } });
    fireEvent.change(contentInput, { target: { value: "Updated content" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updatePrompt).toHaveBeenCalledWith("p1", {
        name: "review-updated",
        content: "Updated content",
        scope: "global",
      });
    });
  });

  it("edits a project prompt and preserves scope/paths", async () => {
    // Validates that editing a project-scoped prompt preserves scope and paths.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p2",
        name: "local-check",
        content: "Run local checks",
        scope: "project",
        projectPath: "/repo",
        projectPaths: ["/repo"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("local-check");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.change(screen.getByDisplayValue("local-check"), { target: { value: "local-check-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updatePrompt).toHaveBeenCalledWith("p2", {
        name: "local-check-v2",
        content: "Run local checks",
        scope: "project",
        projectPaths: ["/repo"],
      });
    });
  });

  it("shows validation feedback while editing when project scope has no folders", async () => {
    // Validates edit mode still surfaces validation errors inside the redesigned editor.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p2",
        name: "local-check",
        content: "Run local checks",
        scope: "project",
        projectPath: "/repo",
        projectPaths: ["/repo"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("local-check");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.click(screen.getByLabelText("Remove folder /repo"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Select at least one project folder")).toBeInTheDocument();
    expect(mockApi.updatePrompt).not.toHaveBeenCalled();
  });

  it("filters prompts by search query", async () => {
    // Validates in-page filtering over prompt name/content/scope.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "p2",
        name: "write-tests",
        content: "Write missing tests",
        scope: "project",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("review-pr");

    fireEvent.change(screen.getByPlaceholderText("Search by title or content..."), {
      target: { value: "write" },
    });
    expect(screen.getByText("write-tests")).toBeInTheDocument();
    expect(screen.queryByText("review-pr")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search by title or content..."), {
      target: { value: "not-found" },
    });
    expect(screen.getByText("No prompts match your search.")).toBeInTheDocument();
  });

  it("shows scope badge with folder chip for project prompts", async () => {
    // Validates the scope badge renders a folder chip for project-scoped prompts.
    // The folder name appears both as the group header and as a chip in the row.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "project-prompt",
        content: "Content",
        scope: "project",
        projectPath: "/home/user/my-project",
        projectPaths: ["/home/user/my-project"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("project-prompt");
    // Folder name appears in both the group header and the scope badge chip
    const folderElements = screen.getAllByText("my-project");
    expect(folderElements.length).toBeGreaterThanOrEqual(2);
  });

  it("shows scope selector in create form with Global and Project folders buttons", async () => {
    // Validates the scope selector UI is rendered.
    render(<PromptsPage embedded />);
    fireEvent.click(screen.getByRole("button", { name: /new prompt/i }));
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Global" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project folders" })).toBeInTheDocument();
  });

  it("shows folder chips and Add folder button when project scope selected", async () => {
    // Validates the folder chip UI renders with remove buttons when project scope is active.
    render(<PromptsPage embedded />);
    fireEvent.click(screen.getByRole("button", { name: /new prompt/i }));
    fireEvent.click(screen.getByRole("button", { name: "Project folders" }));

    // cwd "/repo" should be auto-filled as a chip
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove folder /repo")).toBeInTheDocument();
    expect(screen.getByText("Add folder")).toBeInTheDocument();
  });

  it("removes a folder chip when remove button clicked", async () => {
    // Validates folder removal interaction in the scope selector.
    render(<PromptsPage embedded />);
    fireEvent.click(screen.getByRole("button", { name: /new prompt/i }));
    fireEvent.click(screen.getByRole("button", { name: "Project folders" }));

    // Remove the auto-filled folder
    fireEvent.click(screen.getByLabelText("Remove folder /repo"));

    // No chips should remain, but Add folder should still be visible
    expect(screen.queryByText("repo")).not.toBeInTheDocument();
    expect(screen.getByText("Add folder")).toBeInTheDocument();
  });

  it("shows error when creating project prompt with no folders selected", async () => {
    // Validates client-side validation for empty folder list.
    render(<PromptsPage embedded />);
    fireEvent.click(screen.getByRole("button", { name: /new prompt/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "content" } });
    fireEvent.click(screen.getByRole("button", { name: "Project folders" }));

    // Remove auto-filled folder
    fireEvent.click(screen.getByLabelText("Remove folder /repo"));

    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    expect(screen.getByText("Select at least one project folder")).toBeInTheDocument();
    expect(mockApi.createPrompt).not.toHaveBeenCalled();
  });

  it("displays individual folder chips for multi-folder prompts", async () => {
    // Validates scope badge shows a chip per folder for prompts assigned to multiple folders.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "multi-folder",
        content: "Content",
        scope: "project",
        projectPath: "/home/user/repo-a",
        projectPaths: ["/home/user/repo-a", "/home/user/repo-b", "/home/user/repo-c"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("multi-folder");
    expect(screen.getByText("repo-a")).toBeInTheDocument();
    expect(screen.getByText("repo-b")).toBeInTheDocument();
    expect(screen.getByText("repo-c")).toBeInTheDocument();
  });

  it("renders grouped sections for mixed global and project prompts", async () => {
    // Validates that prompts are grouped under Global and project folder headers.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "g1",
        name: "global-prompt",
        content: "Global content",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "p1",
        name: "project-prompt",
        content: "Project content",
        scope: "project",
        projectPath: "/home/user/my-app",
        projectPaths: ["/home/user/my-app"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("global-prompt");

    // Both prompts visible regardless of session cwd
    expect(screen.getByText("global-prompt")).toBeInTheDocument();
    expect(screen.getByText("project-prompt")).toBeInTheDocument();

    // Group headers present — "Global" header and "my-app" folder header
    expect(screen.getByText("Global")).toBeInTheDocument();
    // "my-app" appears in both group header and scope badge chip
    const folderElements = screen.getAllByText("my-app");
    expect(folderElements.length).toBeGreaterThanOrEqual(2);
  });

  it("edits a project prompt displayed in a project group section", async () => {
    // Validates that edit/save works for prompts rendered under the project folder group.
    mockApi.listPrompts
      .mockResolvedValueOnce([
        {
          id: "p1",
          name: "proj-task",
          content: "Do project task",
          scope: "project",
          projectPath: "/work/repo",
          projectPaths: ["/work/repo"],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ])
      .mockResolvedValueOnce([]); // after save reload
    render(<PromptsPage embedded />);
    await screen.findByText("proj-task");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("proj-task"), { target: { value: "proj-task-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updatePrompt).toHaveBeenCalledWith("p1", {
        name: "proj-task-v2",
        content: "Do project task",
        scope: "project",
        projectPaths: ["/work/repo"],
      });
    });
  });

  it("deletes a project prompt displayed in a project group section", async () => {
    // Validates that delete works for prompts rendered under the project folder group.
    mockApi.listPrompts
      .mockResolvedValueOnce([
        {
          id: "p1",
          name: "to-delete",
          content: "Delete me",
          scope: "project",
          projectPath: "/work/repo",
          projectPaths: ["/work/repo"],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ])
      .mockResolvedValueOnce([]); // after delete reload
    render(<PromptsPage embedded />);
    await screen.findByText("to-delete");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockApi.deletePrompt).toHaveBeenCalledWith("p1");
    });
  });

  it("cancels editing a project prompt in the project group section", async () => {
    // Validates cancel in edit mode for a project-scoped prompt clears edit state.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "proj-cancel",
        content: "Cancel me",
        scope: "project",
        projectPath: "/work/repo",
        projectPaths: ["/work/repo"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("proj-cancel");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByDisplayValue("proj-cancel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByDisplayValue("proj-cancel")).not.toBeInTheDocument();
    expect(screen.getByText("proj-cancel")).toBeInTheDocument();
  });

  it("loads all prompts even without a selected session", async () => {
    // Validates the page fully works with no session selected.
    mockState = {
      currentSessionId: null,
      sessions: new Map(),
      sdkSessions: [],
    };
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "g1",
        name: "always-visible",
        content: "Content",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("always-visible");
    expect(mockApi.listPrompts).toHaveBeenCalledWith();
  });

  it("shows Back button in non-embedded mode", async () => {
    // Validates the Back button renders when not embedded.
    render(<PromptsPage />);
    expect(screen.getByText("Back")).toBeInTheDocument();
  });

  it("cancels editing and resets state", async () => {
    // Validates cancel in edit mode clears edit state.
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    render(<PromptsPage embedded />);
    await screen.findByText("review-pr");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByDisplayValue("review-pr")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Should be back to display mode
    expect(screen.queryByDisplayValue("review-pr")).not.toBeInTheDocument();
    expect(screen.getByText("review-pr")).toBeInTheDocument();
  });

  it("shows loading state initially", () => {
    // Validates loading indicator appears before prompts load.
    render(<PromptsPage embedded />);
    expect(screen.getByText("Loading prompts...")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    // Ensures the PromptsPage meets WCAG accessibility standards.
    const { axe } = await import("vitest-axe");
    mockApi.listPrompts.mockResolvedValueOnce([
      {
        id: "p1",
        name: "review-pr",
        content: "Review this PR",
        scope: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    const { container } = render(<PromptsPage embedded />);
    await screen.findByText("review-pr");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
