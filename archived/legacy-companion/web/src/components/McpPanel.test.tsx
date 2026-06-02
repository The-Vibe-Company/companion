// @vitest-environment jsdom
/**
 * Tests for the McpSection component (McpPanel.tsx).
 *
 * McpSection displays MCP (Model Context Protocol) servers for a given session,
 * including server status, toggle/reconnect controls, and an add-server form.
 * It auto-fetches MCP status when the CLI is connected.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { McpServerDetail } from "../types.js";

// ---- Mock WS functions ----
const mockSendMcpGetStatus = vi.fn();
const mockSendMcpToggle = vi.fn();
const mockSendMcpReconnect = vi.fn();
const mockSendMcpSetServers = vi.fn();

vi.mock("../ws.js", () => ({
  sendMcpGetStatus: (...args: unknown[]) => mockSendMcpGetStatus(...args),
  sendMcpToggle: (...args: unknown[]) => mockSendMcpToggle(...args),
  sendMcpReconnect: (...args: unknown[]) => mockSendMcpReconnect(...args),
  sendMcpSetServers: (...args: unknown[]) => mockSendMcpSetServers(...args),
}));

// ---- Mock Store ----
interface MockStoreState {
  mcpServers: Map<string, McpServerDetail[]>;
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { mcp_servers?: { name: string; status: string }[] }>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    mcpServers: new Map(),
    cliConnected: new Map([["s1", true]]),
    sessions: new Map([["s1", { mcp_servers: [] }]]),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { McpSection } from "./McpPanel.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

// ---- Helper: create a McpServerDetail with sensible defaults ----
function makeServer(overrides: Partial<McpServerDetail> = {}): McpServerDetail {
  return {
    name: "test-server",
    status: "connected",
    config: { type: "stdio", command: "npx", args: ["-y", "mcp-server"] },
    scope: "project",
    tools: [],
    ...overrides,
  };
}

describe("McpSection", () => {
  it("renders 'MCP Servers' heading", () => {
    // The section header should always be visible regardless of server state
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
  });

  it("shows empty state when no servers are configured", () => {
    // When no MCP servers exist and the form is not open, show the empty message
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();
  });

  it("shows 'Add one' link in empty state when CLI is connected", () => {
    // The empty state should offer a clickable link to add a server
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText("Add one")).toBeInTheDocument();
  });

  it("does not show 'Add one' link in empty state when CLI is disconnected", () => {
    // When disconnected, the add-one shortcut should not appear
    resetStore({ cliConnected: new Map([["s1", false]]) });
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();
    expect(screen.queryByText("Add one")).not.toBeInTheDocument();
  });

  it("renders server rows with correct status badges", () => {
    // Each server should display its name and a status label derived from STATUS_STYLES
    const servers = [
      makeServer({ name: "alpha", status: "connected" }),
      makeServer({ name: "beta", status: "failed" }),
      makeServer({ name: "gamma", status: "disabled" }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("shows toggle (disable/enable) buttons on servers", () => {
    // Each server row should have a toggle button to disable or enable
    const servers = [
      makeServer({ name: "enabled-srv", status: "connected" }),
      makeServer({ name: "disabled-srv", status: "disabled" }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    // Connected server should have a "Disable server" button
    expect(screen.getByTitle("Disable server")).toBeInTheDocument();
    // Disabled server should have an "Enable server" button
    expect(screen.getByTitle("Enable server")).toBeInTheDocument();
  });

  it("calls sendMcpToggle when toggle button is clicked", () => {
    // Clicking the disable button should call sendMcpToggle(sessionId, name, false)
    const servers = [makeServer({ name: "my-server", status: "connected" })];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Disable server"));
    expect(mockSendMcpToggle).toHaveBeenCalledWith("s1", "my-server", false);
  });

  it("shows reconnect button for connected and failed servers", () => {
    // Reconnect should appear for "connected" and "failed" statuses (per component logic)
    const servers = [
      makeServer({ name: "ok-srv", status: "connected" }),
      makeServer({ name: "fail-srv", status: "failed" }),
      makeServer({ name: "off-srv", status: "disabled" }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    // Two reconnect buttons: one for connected, one for failed
    const reconnectButtons = screen.getAllByTitle("Reconnect server");
    expect(reconnectButtons).toHaveLength(2);
  });

  it("calls sendMcpReconnect when reconnect button is clicked", () => {
    // Clicking reconnect should call the correct WS function
    const servers = [makeServer({ name: "fail-srv", status: "failed" })];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Reconnect server"));
    expect(mockSendMcpReconnect).toHaveBeenCalledWith("s1", "fail-srv");
  });

  it("does not show reconnect button for disabled or connecting servers", () => {
    // Reconnect should only appear for "connected" and "failed"
    const servers = [
      makeServer({ name: "disabled-srv", status: "disabled" }),
      makeServer({ name: "connecting-srv", status: "connecting" }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    expect(screen.queryByTitle("Reconnect server")).not.toBeInTheDocument();
  });
});

describe("McpSection add server form", () => {
  it("opens form when add button is clicked", () => {
    // Clicking the add button should reveal the AddServerForm
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Add MCP server"));
    expect(screen.getByText("Server Name")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("form shows name input, type selector, and command/args fields for stdio", () => {
    // The default form should show stdio-specific fields (Command, Args)
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    expect(screen.getByPlaceholderText("my-mcp-server")).toBeInTheDocument();
    expect(screen.getByText("stdio")).toBeInTheDocument();
    expect(screen.getByText("sse")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText(/Args/)).toBeInTheDocument();
  });

  it("form shows URL field when type is changed to sse", () => {
    // Switching type to sse should replace command/args with a URL field
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    // Click the sse type button
    fireEvent.click(screen.getByText("sse"));

    expect(screen.getByText("URL")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("http://localhost:3000/mcp")).toBeInTheDocument();
    // Command and Args should not be visible
    expect(screen.queryByText("Command")).not.toBeInTheDocument();
    expect(screen.queryByText(/Args/)).not.toBeInTheDocument();
  });

  it("form shows URL field when type is changed to http", () => {
    // Switching type to http should also show the URL field
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    fireEvent.click(screen.getByText("http"));

    expect(screen.getByText("URL")).toBeInTheDocument();
    expect(screen.queryByText("Command")).not.toBeInTheDocument();
  });

  it("submit calls sendMcpSetServers with stdio config", () => {
    // Submitting a valid stdio form should call the WS function with correct config
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
      target: { value: "my-new-server" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("npx -y @modelcontextprotocol/server-memory"),
      { target: { value: "npx" } },
    );
    fireEvent.change(screen.getByPlaceholderText("--port 3000"), {
      target: { value: "-y @mcp/server" },
    });

    fireEvent.click(screen.getByText("Add Server"));

    expect(mockSendMcpSetServers).toHaveBeenCalledWith("s1", {
      "my-new-server": {
        type: "stdio",
        command: "npx",
        args: ["-y", "@mcp/server"],
      },
    });
  });

  it("submit calls sendMcpSetServers with sse config", () => {
    // Submitting a valid sse form should call with url instead of command
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
      target: { value: "remote-server" },
    });
    fireEvent.click(screen.getByText("sse"));
    fireEvent.change(screen.getByPlaceholderText("http://localhost:3000/mcp"), {
      target: { value: "http://example.com/mcp" },
    });

    fireEvent.click(screen.getByText("Add Server"));

    expect(mockSendMcpSetServers).toHaveBeenCalledWith("s1", {
      "remote-server": {
        type: "sse",
        url: "http://example.com/mcp",
      },
    });
  });

  it("submit button is disabled when form is incomplete", () => {
    // With no name or command, the Add Server button should be disabled
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    const submitButton = screen.getByText("Add Server");
    expect(submitButton).toBeDisabled();
  });

  it("cancel button closes the form", () => {
    // Clicking Cancel should hide the form and return to normal view
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));

    // Form should be visible
    expect(screen.getByText("Server Name")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel"));

    // Form should no longer be visible
    expect(screen.queryByText("Server Name")).not.toBeInTheDocument();
  });

  it("hides empty state when add form is open", () => {
    // When the form is showing, the empty state message should not appear
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Add MCP server"));

    expect(screen.queryByText(/No MCP servers configured/)).not.toBeInTheDocument();
  });
});

describe("McpSection refresh and auto-fetch", () => {
  it("refresh button calls sendMcpGetStatus", () => {
    // Clicking the refresh button should trigger a status fetch
    render(<McpSection sessionId="s1" />);

    // Clear the auto-fetch call that happens on mount
    mockSendMcpGetStatus.mockClear();

    fireEvent.click(screen.getByTitle("Refresh MCP server status"));
    expect(mockSendMcpGetStatus).toHaveBeenCalledWith("s1");
  });

  it("auto-fetches MCP status when CLI is connected (useEffect)", () => {
    // On mount with cliConnected=true, sendMcpGetStatus should be called automatically
    render(<McpSection sessionId="s1" />);
    expect(mockSendMcpGetStatus).toHaveBeenCalledWith("s1");
  });

  it("does not auto-fetch when CLI is disconnected", () => {
    // When cliConnected is false, no automatic status fetch should occur
    resetStore({ cliConnected: new Map([["s1", false]]) });
    render(<McpSection sessionId="s1" />);
    expect(mockSendMcpGetStatus).not.toHaveBeenCalled();
  });
});

describe("McpSection disabled state when not connected", () => {
  it("add button is disabled when CLI is not connected", () => {
    // The add button should be non-interactive when disconnected
    resetStore({ cliConnected: new Map([["s1", false]]) });
    render(<McpSection sessionId="s1" />);

    const addButton = screen.getByTitle("Add MCP server");
    expect(addButton).toBeDisabled();
  });

  it("refresh button is disabled when CLI is not connected", () => {
    // The refresh button should also be disabled when disconnected
    resetStore({ cliConnected: new Map([["s1", false]]) });
    render(<McpSection sessionId="s1" />);

    const refreshButton = screen.getByTitle("Refresh MCP server status");
    expect(refreshButton).toBeDisabled();
  });
});

describe("McpSection fallback from session mcp_servers", () => {
  it("falls back to session mcp_servers when detailed servers are not available", () => {
    // When mcpServers map is empty but session has mcp_servers, use those as fallback
    resetStore({
      mcpServers: new Map(),
      sessions: new Map([
        ["s1", { mcp_servers: [{ name: "fallback-srv", status: "connected" }] }],
      ]),
    });
    render(<McpSection sessionId="s1" />);

    expect(screen.getByText("fallback-srv")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
});

describe("McpSection server row expansion", () => {
  it("expands to show config details when server name is clicked", () => {
    // Clicking a server name should expand to show type, command, scope, etc.
    const servers = [
      makeServer({
        name: "detail-srv",
        status: "connected",
        config: { type: "stdio", command: "npx", args: ["-y", "mcp-tool"] },
        scope: "project",
      }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    // Click the server name to expand
    fireEvent.click(screen.getByText("detail-srv"));

    // Expanded details should show type, command, and scope
    expect(screen.getByText("stdio")).toBeInTheDocument();
    expect(screen.getByText(/npx/)).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
  });

  it("shows tools list when server has tools", () => {
    // Expanded view should list available tools
    const servers = [
      makeServer({
        name: "tool-srv",
        tools: [
          { name: "read_file" },
          { name: "write_file", annotations: { destructive: true } },
        ],
      }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    // Expand the server
    fireEvent.click(screen.getByText("tool-srv"));

    expect(screen.getByText("Tools (2)")).toBeInTheDocument();
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getByText("write_file")).toBeInTheDocument();
  });

  it("shows error message when server has an error", () => {
    // Failed servers with an error message should display it in the expanded view
    const servers = [
      makeServer({
        name: "err-srv",
        status: "failed",
        error: "Connection refused on port 3000",
      }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    // Expand the server
    fireEvent.click(screen.getByText("err-srv"));

    expect(screen.getByText("Connection refused on port 3000")).toBeInTheDocument();
  });

  it("shows URL in expanded view for sse/http servers", () => {
    // SSE and HTTP servers should display their URL instead of command
    const servers = [
      makeServer({
        name: "sse-srv",
        config: { type: "sse", url: "http://example.com/mcp" },
      }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    render(<McpSection sessionId="s1" />);

    fireEvent.click(screen.getByText("sse-srv"));

    expect(screen.getByText("http://example.com/mcp")).toBeInTheDocument();
  });
});

describe("McpSection accessibility", () => {
  it("passes axe accessibility checks with no servers", async () => {
    const { axe } = await import("vitest-axe");
    resetStore();
    const { container } = render(<McpSection sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with servers", async () => {
    const { axe } = await import("vitest-axe");
    const servers = [
      makeServer({ name: "a-srv", status: "connected" }),
      makeServer({ name: "b-srv", status: "failed" }),
    ];
    resetStore({ mcpServers: new Map([["s1", servers]]) });
    const { container } = render(<McpSection sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility checks with add form open", async () => {
    const { axe } = await import("vitest-axe");
    resetStore();
    const { container } = render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Add MCP server"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
