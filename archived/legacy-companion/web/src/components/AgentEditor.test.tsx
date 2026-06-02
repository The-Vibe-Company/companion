// @vitest-environment jsdom
/**
 * Tests for the AgentEditor component in isolation.
 *
 * The AgentEditor is already tested indirectly through AgentsPage.test.tsx,
 * but this file targets specific uncovered branches:
 * - Schedule one-time mode (datetime-local input, lines ~660-669)
 * - MCP server form with SSE/HTTP type (URL input, lines ~774-785)
 * - Adding an MCP server of SSE type
 * - Accessibility scan of the component rendered standalone
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentFormData } from "./AgentEditor.js";
import { EMPTY_FORM, AgentEditor } from "./AgentEditor.js";

// ─── Mock setup ──────────────────────────────────────────────────────────────

// Mock the api module — AgentEditor calls api.listSkills(), api.listEnvs(),
// and api.listLinearOAuthConnections() depending on form state
const mockApi = {
  listSkills: vi.fn().mockResolvedValue([]),
  listEnvs: vi.fn().mockResolvedValue([]),
  listLinearOAuthConnections: vi.fn().mockResolvedValue({ connections: [] }),
};
vi.mock("../api.js", () => ({
  api: {
    listSkills: (...args: unknown[]) => mockApi.listSkills(...args),
    listEnvs: (...args: unknown[]) => mockApi.listEnvs(...args),
    listLinearOAuthConnections: (...args: unknown[]) => mockApi.listLinearOAuthConnections(...args),
  },
}));

// Mock FolderPicker since it has its own API dependencies
vi.mock("./FolderPicker.js", () => ({ FolderPicker: () => null }));

// Mock AgentIcon to a simple span so tests don't rely on SVG internals
vi.mock("./AgentIcon.js", () => ({
  AgentIcon: ({ icon, className }: { icon: string; className?: string }) => (
    <span data-testid="agent-icon" className={className}>{icon}</span>
  ),
  AGENT_ICON_OPTIONS: ["bot", "terminal"],
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Default props for rendering AgentEditor in isolation. */
function renderEditor(formOverrides: Partial<AgentFormData> = {}, propsOverrides: Record<string, unknown> = {}) {
  const form: AgentFormData = { ...EMPTY_FORM, ...formOverrides };
  // Track the latest form state via a ref-like variable
  let currentForm = form;
  const setForm = vi.fn((updater: AgentFormData | ((prev: AgentFormData) => AgentFormData)) => {
    if (typeof updater === "function") {
      currentForm = updater(currentForm);
    } else {
      currentForm = updater;
    }
  });
  const onSave = vi.fn();
  const onCancel = vi.fn();

  const result = render(
    <AgentEditor
      form={form}
      setForm={setForm}
      editingId={null}
      publicUrl=""
      error=""
      saving={false}
      onSave={onSave}
      onCancel={onCancel}
      linearOAuthConfigured={false}
      {...propsOverrides}
    />,
  );

  return { ...result, setForm, onSave, onCancel, getForm: () => currentForm };
}

// ─── Axe rules (matching AgentsPage.test.tsx known exclusions) ───────────────
const axeRules = {
  rules: {
    label: { enabled: false },
    "heading-order": { enabled: false },
    "button-name": { enabled: false },
    "select-name": { enabled: false },
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentEditor", () => {
  // ── Basic rendering ─────────────────────────────────────────────────────────

  it("renders with default empty form and shows New Agent header", () => {
    // When editingId is null, the header should say "New Agent" and
    // the Create button should be present.
    renderEditor();
    expect(screen.getByText("New Agent")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("renders Edit Agent header when editingId is provided", () => {
    // When an editingId is provided, the header changes to "Edit Agent"
    // and the save button reads "Save" instead of "Create".
    renderEditor({}, { editingId: "agent-123" });
    expect(screen.getByText("Edit Agent")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("displays error message when error prop is set", () => {
    // The component should render the error string in a visible banner.
    renderEditor({}, { error: "Something went wrong" });
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  // ── Schedule: One-time mode ────────────────────────────────────────────────

  it("shows datetime-local input when schedule is enabled in one-time mode", () => {
    // When scheduleEnabled=true and scheduleRecurring=false, the component
    // should render a datetime-local input instead of cron presets.
    // This covers the else branch at lines ~665-671.
    renderEditor({
      scheduleEnabled: true,
      scheduleRecurring: false,
      scheduleExpression: "2026-04-01T10:00",
    });

    // The datetime-local input should be visible
    const datetimeInput = screen.getByDisplayValue("2026-04-01T10:00");
    expect(datetimeInput).toBeInTheDocument();
    expect(datetimeInput).toHaveAttribute("type", "datetime-local");
  });

  it("calls setForm when datetime-local value changes in one-time mode", () => {
    // Changing the datetime-local input should call setForm with the
    // updated scheduleExpression value.
    const { setForm } = renderEditor({
      scheduleEnabled: true,
      scheduleRecurring: false,
      scheduleExpression: "2026-04-01T10:00",
    });

    const datetimeInput = screen.getByDisplayValue("2026-04-01T10:00");
    fireEvent.change(datetimeInput, { target: { value: "2026-05-15T14:30" } });

    expect(setForm).toHaveBeenCalled();
  });

  it("toggles between recurring and one-time schedule modes via radio buttons", () => {
    // Clicking the "One-time" radio should call setForm to set
    // scheduleRecurring to false. This exercises the radio button onChange.
    const { setForm } = renderEditor({
      scheduleEnabled: true,
      scheduleRecurring: true,
      scheduleExpression: "0 8 * * *",
    });

    // "Recurring" and "One-time" radio labels should both be visible
    expect(screen.getByText("Recurring")).toBeInTheDocument();
    const oneTimeLabel = screen.getByText("One-time");
    expect(oneTimeLabel).toBeInTheDocument();

    // Click the "One-time" radio button
    const oneTimeRadio = oneTimeLabel.closest("label")!.querySelector("input[type='radio']")!;
    fireEvent.click(oneTimeRadio);

    // setForm should be called to update scheduleRecurring to false
    expect(setForm).toHaveBeenCalled();
  });

  // ── MCP Server: URL type (SSE/HTTP) ────────────────────────────────────────

  it("shows URL input when MCP form is opened and type is changed to SSE", () => {
    // Opening the MCP form and switching to SSE type should show a URL
    // input instead of the command/args fields. This covers lines ~780-789.
    renderEditor();

    // Expand Advanced section
    fireEvent.click(screen.getByText("Advanced"));

    // Click "+ Add Server" to show the MCP form
    fireEvent.click(screen.getByText("+ Add Server"));

    // Verify the MCP form is now visible with the default stdio type showing
    // the command input
    expect(screen.getByPlaceholderText("e.g., my-server")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g., npx -y @some/mcp-server")).toBeInTheDocument();

    // Switch type to SSE
    fireEvent.click(screen.getByText("sse"));

    // After switching to SSE, the URL input should appear and command fields
    // should be gone
    const urlInput = screen.getByPlaceholderText("https://example.com/mcp");
    expect(urlInput).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g., npx -y @some/mcp-server")).not.toBeInTheDocument();
  });

  it("shows URL input when MCP form type is changed to HTTP", () => {
    // Same as SSE but for the HTTP type — both non-stdio types show URL input.
    renderEditor();

    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByText("+ Add Server"));

    // Switch type to HTTP
    fireEvent.click(screen.getByText("http"));

    // URL input should appear
    const urlInput = screen.getByPlaceholderText("https://example.com/mcp");
    expect(urlInput).toBeInTheDocument();
  });

  it("can fill in URL for SSE-type MCP server and add it", () => {
    // End-to-end: open form, switch to SSE, enter name and URL, click Add Server.
    // Verifies the URL value is captured and addMcpServer is invoked via setForm.
    const { setForm } = renderEditor();

    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByText("+ Add Server"));

    // Switch to SSE type
    fireEvent.click(screen.getByText("sse"));

    // Fill in the server name
    const nameInput = screen.getByPlaceholderText("e.g., my-server");
    fireEvent.change(nameInput, { target: { value: "my-sse-server" } });

    // Fill in the URL
    const urlInput = screen.getByPlaceholderText("https://example.com/mcp");
    fireEvent.change(urlInput, { target: { value: "https://example.com/sse" } });

    // Click "Add Server" button
    fireEvent.click(screen.getByText("Add Server"));

    // setForm should have been called with the new MCP server
    expect(setForm).toHaveBeenCalled();
    // Verify the form was updated with the SSE server config
    const lastCall = setForm.mock.calls[setForm.mock.calls.length - 1][0];
    // The updater function should produce a form with the server added
    if (typeof lastCall === "function") {
      const result = lastCall(EMPTY_FORM);
      expect(result.mcpServers).toHaveProperty("my-sse-server");
      expect(result.mcpServers["my-sse-server"].type).toBe("sse");
      expect(result.mcpServers["my-sse-server"].url).toBe("https://example.com/sse");
    }
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  it("passes axe accessibility checks", async () => {
    // The AgentEditor rendered in isolation should have no new a11y violations
    // (with the same known exclusions as AgentsPage.test.tsx).
    const { axe } = await import("vitest-axe");
    const { container } = renderEditor({ name: "Test Agent", prompt: "Do stuff" });
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with schedule one-time mode visible", async () => {
    // Ensures the datetime-local input path is also accessible.
    const { axe } = await import("vitest-axe");
    const { container } = renderEditor({
      name: "Scheduled Agent",
      prompt: "Run once",
      scheduleEnabled: true,
      scheduleRecurring: false,
      scheduleExpression: "2026-04-01T10:00",
    });
    const results = await axe(container, axeRules);
    expect(results).toHaveNoViolations();
  });

  // ── Linear OAuth connection picker ──────────────────────────────────────────

  it("shows 'No OAuth connections found' when Linear is enabled but no connections exist", async () => {
    // When linearEnabled is true but the API returns no connections,
    // the editor should show a message directing the user to set up an OAuth app.
    mockApi.listLinearOAuthConnections.mockResolvedValue({ connections: [] });
    renderEditor({ linearEnabled: true }, { linearOAuthConfigured: true });

    await waitFor(() => {
      expect(screen.getByText(/No OAuth connections found/)).toBeInTheDocument();
    });
    expect(screen.getByText("Set up a Linear OAuth app")).toBeInTheDocument();
  });

  it("shows connection list when Linear is enabled and connections exist", async () => {
    // When linearEnabled is true and the API returns connections,
    // the editor should render each connection as a selectable button.
    mockApi.listLinearOAuthConnections.mockResolvedValue({
      connections: [
        { id: "conn-1", name: "My Linear App", oauthClientId: "c1", status: "connected", hasAccessToken: true, hasClientSecret: true, hasWebhookSecret: true, createdAt: 0, updatedAt: 0 },
        { id: "conn-2", name: "Staging App", oauthClientId: "c2", status: "disconnected", hasAccessToken: false, hasClientSecret: true, hasWebhookSecret: false, createdAt: 0, updatedAt: 0 },
      ],
    });
    renderEditor({ linearEnabled: true }, { linearOAuthConfigured: true });

    await waitFor(() => {
      expect(screen.getByText("My Linear App")).toBeInTheDocument();
    });
    expect(screen.getByText("Staging App")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("auto-selects the only connection when there is exactly one", async () => {
    // When only one connection exists and none is selected,
    // the editor should auto-select it via setForm.
    mockApi.listLinearOAuthConnections.mockResolvedValue({
      connections: [
        { id: "conn-only", name: "Only App", oauthClientId: "c1", status: "connected", hasAccessToken: true, hasClientSecret: true, hasWebhookSecret: true, createdAt: 0, updatedAt: 0 },
      ],
    });
    const { setForm } = renderEditor({ linearEnabled: true }, { linearOAuthConfigured: true });

    await waitFor(() => {
      expect(screen.getByText("Only App")).toBeInTheDocument();
    });
    // setForm should have been called to auto-select the connection
    expect(setForm).toHaveBeenCalled();
    const calls = setForm.mock.calls;
    const autoSelectCall = calls.find((c: unknown[]) => {
      if (typeof c[0] === "function") {
        const result = (c[0] as (prev: AgentFormData) => AgentFormData)({ ...EMPTY_FORM, linearEnabled: true });
        return result.linearOAuthConnectionId === "conn-only";
      }
      return false;
    });
    expect(autoSelectCall).toBeDefined();
  });

  it("clicking a connection selects it via setForm", async () => {
    // Clicking a connection button should call setForm to update linearOAuthConnectionId.
    mockApi.listLinearOAuthConnections.mockResolvedValue({
      connections: [
        { id: "conn-1", name: "App One", oauthClientId: "c1", status: "connected", hasAccessToken: true, hasClientSecret: true, hasWebhookSecret: true, createdAt: 0, updatedAt: 0 },
        { id: "conn-2", name: "App Two", oauthClientId: "c2", status: "connected", hasAccessToken: true, hasClientSecret: true, hasWebhookSecret: true, createdAt: 0, updatedAt: 0 },
      ],
    });
    const { setForm } = renderEditor(
      { linearEnabled: true, linearOAuthConnectionId: "conn-1" },
      { linearOAuthConfigured: true },
    );

    await waitFor(() => {
      expect(screen.getByText("App Two")).toBeInTheDocument();
    });

    // Click the second connection
    fireEvent.click(screen.getByText("App Two"));

    // setForm should be called to select conn-2
    expect(setForm).toHaveBeenCalled();
    const calls = setForm.mock.calls;
    const selectCall = calls.find((c: unknown[]) => {
      if (typeof c[0] === "function") {
        const result = (c[0] as (prev: AgentFormData) => AgentFormData)({
          ...EMPTY_FORM,
          linearEnabled: true,
          linearOAuthConnectionId: "conn-1",
        });
        return result.linearOAuthConnectionId === "conn-2";
      }
      return false;
    });
    expect(selectCall).toBeDefined();
  });

  it("shows loading state while fetching connections", () => {
    // When linearEnabled is true and connections are still loading,
    // the editor should show "Loading connections..."
    mockApi.listLinearOAuthConnections.mockReturnValue(new Promise(() => {}));
    renderEditor({ linearEnabled: true }, { linearOAuthConfigured: true });

    expect(screen.getByText("Loading connections...")).toBeInTheDocument();
  });

  it("does not show connection picker when Linear is not enabled", () => {
    // The connection picker should not appear when linearEnabled is false.
    renderEditor({ linearEnabled: false });
    expect(screen.queryByTestId("linear-connection-picker")).not.toBeInTheDocument();
  });
});
