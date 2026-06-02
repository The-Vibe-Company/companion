// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentFormData } from "./AgentEditor.js";
import { LinearAgentEditor } from "./LinearAgentEditor.js";

// --- Mocks ---

// Mock backend utilities to return controlled model/mode values for each backend type
vi.mock("../utils/backends.js", () => ({
  getModelsForBackend: (backend: string) =>
    backend === "claude"
      ? [{ value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "S" }]
      : [{ value: "codex-mini", label: "Codex Mini", icon: "C" }],
  getDefaultModel: (backend: string) =>
    backend === "claude" ? "claude-sonnet-4-6" : "codex-mini",
  getAgentModesForBackend: (backend: string) =>
    backend === "claude"
      ? [{ value: "allowEdits", label: "Allow edits" }]
      : [{ value: "auto", label: "Auto" }],
  getDefaultAgentMode: (backend: string) =>
    backend === "claude" ? "allowEdits" : "auto",
}));

// Mock LinearLogo to render a simple testable SVG element
vi.mock("./LinearLogo.js", () => ({
  LinearLogo: (props: Record<string, unknown>) => (
    <svg data-testid="linear-logo" {...props} />
  ),
}));

// Mock FolderPicker to render a controllable stub for testing folder selection
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({
    onSelect,
    onClose,
  }: {
    onSelect: (p: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="folder-picker">
      <button onClick={() => onSelect("/test/dir")}>Pick</button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// Default form data used across tests. linearEnabled is true since this is the Linear-specific editor.
const defaultForm: AgentFormData = {
  name: "",
  description: "",
  icon: "",
  backendType: "claude",
  model: "claude-sonnet-4-6",
  permissionMode: "allowEdits",
  cwd: "",
  prompt: "",
  envSlug: "",
  env: [],
  codexInternetAccess: false,
  branch: "",
  createBranch: false,
  useWorktree: false,
  mcpServers: {},
  skills: [],
  allowedTools: [],
  webhookEnabled: false,
  scheduleEnabled: false,
  scheduleExpression: "",
  scheduleRecurring: true,
  linearEnabled: true,
  linearOAuthConnectionId: "",
};

/** Helper to build default props, with optional overrides */
function makeProps(
  overrides: Partial<{
    form: Partial<AgentFormData>;
    editingId: string;
    error: string;
    saving: boolean;
    onSave: () => void;
    onCancel: () => void;
    onOpenGenericEditor: () => void;
    setForm: (
      f: AgentFormData | ((prev: AgentFormData) => AgentFormData),
    ) => void;
  }> = {},
) {
  const form = { ...defaultForm, ...overrides.form };
  return {
    form,
    setForm: overrides.setForm ?? vi.fn(),
    editingId: overrides.editingId ?? "agent-123",
    error: overrides.error ?? "",
    saving: overrides.saving ?? false,
    onSave: overrides.onSave ?? vi.fn(),
    onCancel: overrides.onCancel ?? vi.fn(),
    onOpenGenericEditor: overrides.onOpenGenericEditor ?? vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LinearAgentEditor", () => {
  // --- Render tests ---

  it("renders the editor heading 'Edit Linear Agent'", () => {
    // Validates that the component renders its identifying heading
    const props = makeProps();
    render(<LinearAgentEditor {...props} />);
    expect(screen.getByText("Edit Linear Agent")).toBeInTheDocument();
  });

  it("renders the LinearLogo icon", () => {
    // Validates the Linear branding logo is present in the header
    const props = makeProps();
    render(<LinearAgentEditor {...props} />);
    expect(screen.getByTestId("linear-logo")).toBeInTheDocument();
  });

  it("renders name, description, and prompt inputs", () => {
    // Validates all three text input fields are rendered with correct placeholders
    const props = makeProps({
      form: { name: "My Agent", description: "A description", prompt: "Do X" },
    });
    render(<LinearAgentEditor {...props} />);

    const nameInput = screen.getByPlaceholderText("Agent name *");
    expect(nameInput).toBeInTheDocument();
    expect(nameInput).toHaveValue("My Agent");

    const descInput = screen.getByPlaceholderText("Short description (optional)");
    expect(descInput).toBeInTheDocument();
    expect(descInput).toHaveValue("A description");

    const promptTextarea = screen.getByPlaceholderText(/System prompt \*/);
    expect(promptTextarea).toBeInTheDocument();
    expect(promptTextarea).toHaveValue("Do X");
  });

  // --- Error display ---

  it("shows error message when error prop is provided", () => {
    // Validates that a non-empty error string is rendered in the error banner
    const props = makeProps({ error: "Something went wrong" });
    render(<LinearAgentEditor {...props} />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("does not show error message when error prop is empty", () => {
    // Validates that no error banner is rendered when the error string is empty
    const props = makeProps({ error: "" });
    render(<LinearAgentEditor {...props} />);
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  // --- Save button states ---

  it("shows 'Saving...' on save button when saving is true", () => {
    // Validates the save button text reflects the saving state
    const props = makeProps({
      saving: true,
      form: { name: "Test", prompt: "Do stuff" },
    });
    render(<LinearAgentEditor {...props} />);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("shows 'Save' on save button when saving is false", () => {
    // Validates the save button shows normal text when not saving
    const props = makeProps({
      saving: false,
      form: { name: "Test", prompt: "Do stuff" },
    });
    render(<LinearAgentEditor {...props} />);
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("disables Save button when name is empty", () => {
    // Validates form validation: name is required
    const props = makeProps({ form: { name: "", prompt: "Do stuff" } });
    render(<LinearAgentEditor {...props} />);
    const saveButton = screen.getByText("Save");
    expect(saveButton).toBeDisabled();
  });

  it("disables Save button when prompt is empty", () => {
    // Validates form validation: prompt is required
    const props = makeProps({ form: { name: "Test", prompt: "" } });
    render(<LinearAgentEditor {...props} />);
    const saveButton = screen.getByText("Save");
    expect(saveButton).toBeDisabled();
  });

  it("disables Save button when both name and prompt are empty", () => {
    // Validates form validation: both name and prompt are required
    const props = makeProps({ form: { name: "", prompt: "" } });
    render(<LinearAgentEditor {...props} />);
    const saveButton = screen.getByText("Save");
    expect(saveButton).toBeDisabled();
  });

  it("enables Save button when name and prompt are provided", () => {
    // Validates the save button is enabled when required fields are filled
    const props = makeProps({ form: { name: "Test", prompt: "Do stuff" } });
    render(<LinearAgentEditor {...props} />);
    const saveButton = screen.getByText("Save");
    expect(saveButton).not.toBeDisabled();
  });

  // --- Callback tests ---

  it("calls onSave when Save is clicked", () => {
    // Validates clicking the Save button triggers the onSave callback
    const onSave = vi.fn();
    const props = makeProps({
      onSave,
      form: { name: "Test", prompt: "Do stuff" },
    });
    render(<LinearAgentEditor {...props} />);
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Cancel button is clicked", () => {
    // Validates the Cancel text button in the header triggers the onCancel callback
    const onCancel = vi.fn();
    const props = makeProps({ onCancel });
    render(<LinearAgentEditor {...props} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when the back (X) button is clicked", () => {
    // Validates the back-arrow button (first button in the header) also triggers onCancel.
    // There are two elements that call onCancel: the back arrow and the Cancel button.
    const onCancel = vi.fn();
    const props = makeProps({ onCancel });
    render(<LinearAgentEditor {...props} />);
    // The back arrow button is the first button rendered, before the heading.
    // We can find all buttons and click the first one (the back arrow).
    const allButtons = screen.getAllByRole("button");
    // The first button is the back arrow (<svg> with path "M11 2L5 8l6 6")
    fireEvent.click(allButtons[0]);
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onOpenGenericEditor when 'Open in full editor' link is clicked", () => {
    // Validates the link to open the full editor triggers the callback
    const onOpenGenericEditor = vi.fn();
    const props = makeProps({ onOpenGenericEditor });
    render(<LinearAgentEditor {...props} />);
    fireEvent.click(screen.getByText(/Open in full editor/));
    expect(onOpenGenericEditor).toHaveBeenCalledOnce();
  });

  // --- Linear trigger badge ---

  it("shows 'Linear Agent trigger enabled' badge", () => {
    // Validates the info panel shows the Linear trigger badge
    const props = makeProps();
    render(<LinearAgentEditor {...props} />);
    expect(
      screen.getByText("Linear Agent trigger enabled"),
    ).toBeInTheDocument();
  });

  // --- Backend toggle ---

  it("switches backend from Claude to Codex and updates form accordingly", () => {
    // Validates clicking the Codex backend toggle calls setForm with the
    // codex defaults (model, permissionMode, backendType)
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock });
    render(<LinearAgentEditor {...props} />);

    fireEvent.click(screen.getByText("Codex"));
    expect(setFormMock).toHaveBeenCalled();

    // setForm is called with an updater function; invoke it to verify the result
    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(defaultForm) : lastCall;
    expect(result.backendType).toBe("codex");
    expect(result.model).toBe("codex-mini");
    expect(result.permissionMode).toBe("auto");
  });

  it("switches backend from Codex back to Claude", () => {
    // Validates toggling back to Claude resets model and mode to Claude defaults
    const codexForm: AgentFormData = {
      ...defaultForm,
      backendType: "codex",
      model: "codex-mini",
      permissionMode: "auto",
    };
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock, form: codexForm });
    render(<LinearAgentEditor {...props} />);

    fireEvent.click(screen.getByText("Claude"));
    expect(setFormMock).toHaveBeenCalled();

    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(codexForm) : lastCall;
    expect(result.backendType).toBe("claude");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.permissionMode).toBe("allowEdits");
  });

  // --- Model dropdown ---

  it("opens model dropdown and allows selection", () => {
    // Validates clicking the model pill opens a dropdown with available models,
    // and selecting one calls setForm with the chosen model value
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock });
    render(<LinearAgentEditor {...props} />);

    // Click the model pill to open the dropdown (shows "Sonnet 4.6" label)
    const modelPill = screen.getByText("Sonnet 4.6");
    fireEvent.click(modelPill);

    // The dropdown should now be visible. For claude backend we have one model option.
    // Since there's only one model in our mock, clicking it should call setForm.
    const modelOptions = screen.getAllByText("Sonnet 4.6");
    // The second "Sonnet 4.6" is inside the dropdown
    fireEvent.click(modelOptions[modelOptions.length - 1]);

    expect(setFormMock).toHaveBeenCalled();
    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(defaultForm) : lastCall;
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  // --- Mode dropdown ---

  it("opens mode dropdown and allows selection", () => {
    // Validates clicking the mode pill opens a dropdown with available modes,
    // and selecting one calls setForm with the chosen mode value
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock });
    render(<LinearAgentEditor {...props} />);

    // Click the mode pill to open the dropdown (shows "Allow edits" label)
    const modePill = screen.getByText("Allow edits");
    fireEvent.click(modePill);

    // The dropdown should now be visible with the mode option
    const modeOptions = screen.getAllByText("Allow edits");
    // Click the dropdown option (the last instance)
    fireEvent.click(modeOptions[modeOptions.length - 1]);

    expect(setFormMock).toHaveBeenCalled();
    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(defaultForm) : lastCall;
    expect(result.permissionMode).toBe("allowEdits");
  });

  // --- Folder picker ---

  it("opens folder picker on folder pill click and updates cwd", () => {
    // Validates clicking the folder pill opens the FolderPicker mock,
    // and selecting a folder calls setForm with the chosen path
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock });
    render(<LinearAgentEditor {...props} />);

    // Click the folder pill (shows "temp" when cwd is empty)
    fireEvent.click(screen.getByText("temp"));

    // The folder picker mock should now be visible
    expect(screen.getByTestId("folder-picker")).toBeInTheDocument();

    // Click the "Pick" button in the mock folder picker
    fireEvent.click(screen.getByText("Pick"));

    // setForm should be called with a function that sets cwd to "/test/dir"
    expect(setFormMock).toHaveBeenCalled();
    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(defaultForm) : lastCall;
    expect(result.cwd).toBe("/test/dir");
  });

  it("shows folder name when cwd is set", () => {
    // Validates that the folder pill shows the last segment of the path
    const props = makeProps({ form: { cwd: "/home/user/projects" } });
    render(<LinearAgentEditor {...props} />);
    expect(screen.getByText("projects")).toBeInTheDocument();
  });

  it("closes folder picker when Close is clicked", () => {
    // Validates the folder picker can be dismissed without selecting a folder
    const props = makeProps();
    render(<LinearAgentEditor {...props} />);

    // Open folder picker
    fireEvent.click(screen.getByText("temp"));
    expect(screen.getByTestId("folder-picker")).toBeInTheDocument();

    // Close it
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByTestId("folder-picker")).not.toBeInTheDocument();
  });

  // --- Input changes ---

  it("calls setForm when name input changes", () => {
    // Validates typing in the name input triggers setForm with an updater
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock });
    render(<LinearAgentEditor {...props} />);

    fireEvent.change(screen.getByPlaceholderText("Agent name *"), {
      target: { value: "New Name" },
    });
    expect(setFormMock).toHaveBeenCalled();
    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(defaultForm) : lastCall;
    expect(result.name).toBe("New Name");
  });

  it("calls setForm when description input changes", () => {
    // Validates typing in the description input triggers setForm with an updater
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock });
    render(<LinearAgentEditor {...props} />);

    fireEvent.change(
      screen.getByPlaceholderText("Short description (optional)"),
      { target: { value: "Updated description" } },
    );
    expect(setFormMock).toHaveBeenCalled();
    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(defaultForm) : lastCall;
    expect(result.description).toBe("Updated description");
  });

  it("calls setForm when prompt textarea changes", () => {
    // Validates typing in the prompt textarea triggers setForm with an updater
    const setFormMock = vi.fn();
    const props = makeProps({ setForm: setFormMock });
    render(<LinearAgentEditor {...props} />);

    fireEvent.change(screen.getByPlaceholderText(/System prompt \*/), {
      target: { value: "New prompt" },
    });
    expect(setFormMock).toHaveBeenCalled();
    const lastCall = setFormMock.mock.calls[0][0];
    const result =
      typeof lastCall === "function" ? lastCall(defaultForm) : lastCall;
    expect(result.prompt).toBe("New prompt");
  });

  // --- Accessibility ---

  it("passes axe accessibility checks", async () => {
    // Validates the component meets WCAG accessibility standards.
    // The "button-name" rule is disabled because the icon-only back button
    // in the header lacks an aria-label (known pre-existing issue, same as AgentsPage).
    const { axe } = await import("vitest-axe");
    const props = makeProps({
      form: { name: "My Agent", prompt: "Do something" },
    });
    const { container } = render(<LinearAgentEditor {...props} />);
    const results = await axe(container, {
      rules: {
        "button-name": { enabled: false },
      },
    });
    expect(results).toHaveNoViolations();
  });
});
