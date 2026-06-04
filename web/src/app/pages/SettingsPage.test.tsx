/**
 * SettingsPage tests.
 *
 * The page is the read-only Workspace Settings view. We mock the API client at
 * its module boundary (never the network/a live server) and assert observable
 * behavior:
 *
 *  - the workspace summary (name / root / agent count) renders from the DTO;
 *  - each provider renders as NAME + a Present/Missing badge — and crucially the
 *    UI never surfaces a secret value (it must not invent one, since the DTO
 *    carries none);
 *  - the loading, empty-providers, and error (with retry) states each render;
 *  - retry re-invokes getWorkspace.
 *
 * No routing hooks are used by this page, so it is rendered directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the client boundary: the page imports `getWorkspace` from "../../api/client".
vi.mock("../../api/client", () => ({
  getWorkspace: vi.fn(),
}));

import SettingsPage from "./SettingsPage";
import { getWorkspace } from "../../api/client";
import type { WorkspaceInfo } from "../../api/types";

const mockedGetWorkspace = vi.mocked(getWorkspace);

/** Builds a WorkspaceInfo fixture with overridable fields. */
function workspace(over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    name: "demo-fleet",
    root: "/home/op/.local/fleets/demo",
    agent_count: 3,
    providers: [
      { name: "OPENROUTER_API_KEY", present: true },
      { name: "ANTHROPIC_API_KEY", present: false },
    ],
    ...over,
  };
}

beforeEach(() => {
  mockedGetWorkspace.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPage", () => {
  it("renders the workspace summary from the loaded info", async () => {
    mockedGetWorkspace.mockResolvedValue(workspace());
    render(<SettingsPage />);

    // The page heading is always present.
    expect(
      screen.getByRole("heading", { level: 1, name: /settings/i }),
    ).toBeInTheDocument();

    // Workspace fields appear once the data resolves.
    expect(await screen.findByText("demo-fleet")).toBeInTheDocument();
    expect(
      screen.getByText("/home/op/.local/fleets/demo"),
    ).toBeInTheDocument();
    // agent_count is rendered (alongside an "Agents" label).
    const agentsTerm = screen.getByText("Agents");
    const agentsRow = agentsTerm.closest("div");
    expect(agentsRow).not.toBeNull();
    expect(within(agentsRow as HTMLElement).getByText("3")).toBeInTheDocument();

    expect(mockedGetWorkspace).toHaveBeenCalledTimes(1);
  });

  it("shows a loading indicator before the workspace resolves", async () => {
    // A never-resolving promise keeps the page in its loading state.
    let resolve: (w: WorkspaceInfo) => void = () => {};
    mockedGetWorkspace.mockReturnValue(
      new Promise<WorkspaceInfo>((r) => {
        resolve = r;
      }),
    );
    render(<SettingsPage />);

    // The status spinner announces loading while pending. Its label is in a
    // visually-hidden span, so assert on the live region's text content.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/loading workspace settings/i);
    // Nothing has rendered yet from the (absent) data.
    expect(screen.queryByText(/providers/i)).not.toBeInTheDocument();

    // Resolve and confirm the loading indicator gives way to content.
    resolve(workspace());
    expect(await screen.findByText("demo-fleet")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lists each provider as name + a Present/Missing badge, never a value", async () => {
    mockedGetWorkspace.mockResolvedValue(
      workspace({
        providers: [
          { name: "OPENROUTER_API_KEY", present: true },
          { name: "ANTHROPIC_API_KEY", present: false },
        ],
      }),
    );
    render(<SettingsPage />);

    // Provider names are shown as row headers in the providers table.
    const presentRow = (await screen.findByText("OPENROUTER_API_KEY")).closest(
      "tr",
    ) as HTMLElement;
    const missingRow = screen
      .getByText("ANTHROPIC_API_KEY")
      .closest("tr") as HTMLElement;

    expect(presentRow).not.toBeNull();
    expect(missingRow).not.toBeNull();

    // The present credential shows "Present"; the absent one shows "Missing".
    expect(within(presentRow).getByText(/present/i)).toBeInTheDocument();
    expect(within(presentRow).queryByText(/missing/i)).not.toBeInTheDocument();
    expect(within(missingRow).getByText(/missing/i)).toBeInTheDocument();
    expect(within(missingRow).queryByText(/present/i)).not.toBeInTheDocument();

    // Each provider row's visible text is exactly its name plus its status —
    // no secret value is rendered. (Defends the "name + present only" contract.)
    expect(presentRow.textContent).toBe("OPENROUTER_API_KEYPresent");
    expect(missingRow.textContent).toBe("ANTHROPIC_API_KEYMissing");
  });

  it("never renders a provider secret value even if one were present on the object", async () => {
    // The typed DTO has no value field, but a careless implementation might read
    // an unexpected property. Smuggle a secret-shaped extra field and assert it
    // is nowhere in the DOM.
    const SECRET = "sk-or-v1-SUPERSECRETVALUE";
    const sneaky = {
      name: "OPENROUTER_API_KEY",
      present: true,
      // Extra, non-contract field that must never be displayed.
      value: SECRET,
    } as unknown as WorkspaceInfo["providers"][number];

    mockedGetWorkspace.mockResolvedValue(
      workspace({ providers: [sneaky] }),
    );
    render(<SettingsPage />);

    await screen.findByText("OPENROUTER_API_KEY");
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("renders an empty state when the workspace has no providers", async () => {
    mockedGetWorkspace.mockResolvedValue(workspace({ providers: [] }));
    render(<SettingsPage />);

    // Workspace summary still renders…
    expect(await screen.findByText("demo-fleet")).toBeInTheDocument();
    // …and the providers section shows its empty placeholder instead of a table.
    // Match the exact title (the description also contains the phrase).
    expect(
      screen.getByText("No provider credentials"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an error banner with a working retry on load failure", async () => {
    // First call fails, second (after retry) succeeds. A plain Error is enough:
    // ErrorBanner renders any Error's message, and the page surfaces it.
    mockedGetWorkspace
      .mockRejectedValueOnce(new Error("workspace load failed"))
      .mockResolvedValueOnce(workspace());

    const user = userEvent.setup();
    render(<SettingsPage />);

    // The alert surfaces the server's message.
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/could not load workspace settings/i)).toBeInTheDocument();
    expect(within(alert).getByText(/workspace load failed/i)).toBeInTheDocument();

    // Retrying re-invokes the client and renders the recovered data.
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByText("demo-fleet")).toBeInTheDocument();
    await waitFor(() => expect(mockedGetWorkspace).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
