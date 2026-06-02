// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockGetClaudeConfig = vi.fn();
const mockReadFile = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    getClaudeConfig: (...args: unknown[]) => mockGetClaudeConfig(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    getClaudeMdFiles: vi.fn().mockResolvedValue({ files: [] }),
    saveClaudeMd: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

interface MockStoreState {
  sessions: Map<string, { cwd?: string; repo_root?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessions: new Map([["s1", { cwd: "/repo", repo_root: "/repo" }]]),
    sdkSessions: [],
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

// Mock ClaudeMdEditor to avoid complex dependency
vi.mock("./ClaudeMdEditor.js", () => ({
  ClaudeMdEditor: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="claude-md-editor">
      <button onClick={onClose}>Close Editor</button>
    </div>
  ),
}));

import { ClaudeConfigBrowser } from "./ClaudeConfigBrowser.js";

const fullConfig = {
  project: {
    root: "/repo",
    claudeMd: [
      { path: "/repo/CLAUDE.md", content: "# Project" },
      { path: "/repo/.claude/CLAUDE.md", content: "# Inner" },
    ],
    settings: { path: "/repo/.claude/settings.json", content: '{"key":"value"}' },
    settingsLocal: null,
    commands: [
      { name: "deploy", path: "/repo/.claude/commands/deploy.md" },
    ],
  },
  user: {
    root: "/Users/test/.claude",
    claudeMd: { path: "/Users/test/.claude/CLAUDE.md", content: "# User" },
    skills: [
      { slug: "my-skill", name: "My Skill", description: "A test skill", path: "/Users/test/.claude/skills/my-skill/SKILL.md" },
      { slug: "other-skill", name: "Other Skill", description: "Another", path: "/Users/test/.claude/skills/other-skill/SKILL.md" },
    ],
    agents: [
      { name: "researcher", path: "/Users/test/.claude/agents/researcher.md" },
    ],
    settings: { path: "/Users/test/.claude/settings.json", content: '{"global":true}' },
    commands: [
      { name: "commit", path: "/Users/test/.claude/commands/commit.md" },
    ],
  },
};

describe("ClaudeConfigBrowser", () => {
  beforeEach(() => {
    resetStore();
    mockGetClaudeConfig.mockResolvedValue(fullConfig);
    mockReadFile.mockResolvedValue({ content: '{"test":true}' });
  });

  // Renders the component and waits for data to load
  it("renders project and user section headers after loading", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText(/Project/)).toBeInTheDocument();
      expect(screen.getByText(/User/)).toBeInTheDocument();
    });
  });

  // Checks that correct counts are displayed in section headers
  it("shows correct item counts in section headers", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      // Project: 2 claudeMd + 1 settings + 0 settingsLocal + 1 command = 4
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
      // User: 1 claudeMd + 2 skills + 1 agent + 1 settings + 1 command = 6
      expect(screen.getByText("User (6)")).toBeInTheDocument();
    });
  });

  // Sections start collapsed and expand on click
  it("expands project section on click to reveal items", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });
    // Items should not be visible before expanding
    expect(screen.queryByText("CLAUDE.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Project (4)"));
    // After expanding, project CLAUDE.md files should be visible
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText(".claude/CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("settings.json")).toBeInTheDocument();
  });

  // User section shows skills with count
  it("expands user section to show skills, agents, and commands", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("User (6)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("User (6)"));
    // Skills header with count
    expect(screen.getByText("Skills (2)")).toBeInTheDocument();
    expect(screen.getByText("My Skill")).toBeInTheDocument();
    expect(screen.getByText("Other Skill")).toBeInTheDocument();
    // Agents
    expect(screen.getByText("Agents (1)")).toBeInTheDocument();
    expect(screen.getByText("researcher")).toBeInTheDocument();
    // Commands
    expect(screen.getByText(/Commands \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("/commit")).toBeInTheDocument();
  });

  // Clicking a .md item opens the ClaudeMdEditor
  it("opens ClaudeMdEditor when clicking a CLAUDE.md item", async () => {
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Project (4)"));
    fireEvent.click(screen.getByText("CLAUDE.md"));

    expect(screen.getByTestId("claude-md-editor")).toBeInTheDocument();
  });

  // Clicking a skill opens the generic markdown editor, not ClaudeMdEditor
  it("opens generic file editor when clicking a skill item", async () => {
    mockReadFile.mockResolvedValue({ content: "# My Skill\nSome content" });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("User (6)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("User (6)"));
    fireEvent.click(screen.getByText("My Skill"));

    // Generic MarkdownFileEditor shows a Save button and the file path
    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
    // "My Skill" appears in both the list row and the editor header — verify there are 2
    expect(screen.getAllByText("My Skill")).toHaveLength(2);
    // Should NOT open the ClaudeMdEditor
    expect(screen.queryByTestId("claude-md-editor")).not.toBeInTheDocument();
  });

  // Clicking a .json item opens the JSON viewer
  it("opens read-only JSON viewer when clicking settings.json", async () => {
    mockReadFile.mockResolvedValue({ content: '{"key":"value"}' });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Project (4)"));
    // Find the settings.json button (not the one under User)
    const settingsButtons = screen.getAllByText("settings.json");
    fireEvent.click(settingsButtons[0]);

    // JSON viewer should appear with read-only indicator
    await waitFor(() => {
      expect(screen.getByText("Read-only")).toBeInTheDocument();
    });
  });

  // Handles no cwd gracefully
  it("returns null when no cwd is available", () => {
    resetStore({
      sessions: new Map([["s1", {}]]),
    });
    const { container } = render(<ClaudeConfigBrowser sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  // Handles empty config
  it("shows empty state messages when no config items exist", async () => {
    mockGetClaudeConfig.mockResolvedValue({
      project: { root: "/repo", claudeMd: [], settings: null, settingsLocal: null, commands: [] },
      user: { root: "/Users/test/.claude", claudeMd: null, skills: [], agents: [], settings: null, commands: [] },
    });
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (0)")).toBeInTheDocument();
      expect(screen.getByText("User (0)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Project (0)"));
    expect(screen.getByText("No .claude config found")).toBeInTheDocument();
  });

  // Accessibility: passes axe scan
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    render(<ClaudeConfigBrowser sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Project (4)")).toBeInTheDocument();
    });
    const { container } = render(<ClaudeConfigBrowser sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
