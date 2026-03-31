// @vitest-environment jsdom
/**
 * Tests for the unified EnvironmentPanel component (split-layout version).
 *
 * Validates:
 * - Empty state (no services/ports) shows setup hints
 * - Sandbox-aware empty states
 * - Sandbox browser preview CTA when no ports are configured
 * - Services render with name, status dot, and port
 * - Ports render with labels and port numbers
 * - Clicking an HTTP port opens the iframe preview (local) or sets pendingBrowserUrl (sandbox)
 * - TCP-only ports trigger health check refresh
 * - Custom URL input navigation
 * - openOnReady auto-navigate
 * - Reload config button
 * - Accessibility (axe scan)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useStore } from "../store.js";
import type { PortStatusInfo, ServiceInfo } from "../store/environment-slice.js";

const mockCheckPort = vi.fn();
const mockReloadLaunchConfig = vi.fn().mockResolvedValue({ reloaded: true });
const mockRestartService = vi.fn().mockResolvedValue({ ok: true });
const mockStopService = vi.fn().mockResolvedValue({ ok: true });
const mockGetServiceLogs = vi.fn().mockResolvedValue({ logs: [] });
const mockGetServices = vi.fn().mockResolvedValue([]);
const mockGetPortStatuses = vi.fn().mockResolvedValue([]);

vi.mock("../api.js", () => ({
  api: {
    checkPort: (...args: unknown[]) => mockCheckPort(...args),
    reloadLaunchConfig: (...args: unknown[]) => mockReloadLaunchConfig(...args),
    restartService: (...args: unknown[]) => mockRestartService(...args),
    stopService: (...args: unknown[]) => mockStopService(...args),
    getServiceLogs: (...args: unknown[]) => mockGetServiceLogs(...args),
    getServices: (...args: unknown[]) => mockGetServices(...args),
    getPortStatuses: (...args: unknown[]) => mockGetPortStatuses(...args),
  },
}));

vi.mock("./SessionBrowserPane.js", () => ({
  SessionBrowserPane: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-browser-pane">SessionBrowserPane:{sessionId}</div>
  ),
}));

import { EnvironmentPanel } from "./EnvironmentPanel.js";

const SESSION_ID = "test-session-1";

function setPortStatuses(ports: PortStatusInfo[]) {
  useStore.getState().setPortStatuses(SESSION_ID, ports);
}

function setServiceStatuses(services: ServiceInfo[]) {
  useStore.getState().setServiceStatuses(SESSION_ID, services);
}

function setupSandboxSession() {
  const sessions = new Map(useStore.getState().sessions);
  sessions.set(SESSION_ID, {
    session_id: SESSION_ID,
    is_containerized: true,
    model: "test", cwd: "/app", tools: [], permissionMode: "default",
    claude_code_version: "1.0", mcp_servers: [], agents: [], slash_commands: [],
    skills: [], total_cost_usd: 0, num_turns: 0, context_used_percent: 0,
    is_compacting: false, git_branch: "main", is_worktree: false, repo_root: "/app",
    git_ahead: 0, git_behind: 0, total_lines_added: 0, total_lines_removed: 0,
  });
  useStore.setState({ sessions });
}

beforeEach(() => {
  mockCheckPort.mockReset();
  mockReloadLaunchConfig.mockClear();
  mockRestartService.mockClear();
  mockStopService.mockClear();
  mockGetServiceLogs.mockClear().mockResolvedValue({ logs: [] });
  mockGetServices.mockClear().mockResolvedValue([]);
  mockGetPortStatuses.mockClear().mockResolvedValue([]);
  useStore.getState().clearEnvironment(SESSION_ID);
  const sessions = new Map(useStore.getState().sessions);
  sessions.delete(SESSION_ID);
  useStore.setState({ sessions });
});

describe("EnvironmentPanel", () => {
  // ─── Empty state ──────────────────────────────────────────────────────
  it("shows setup hint when no services or ports configured (local mode)", () => {
    // Both the left sidebar and right panel guide users to create launch.json
    render(<EnvironmentPanel sessionId={SESSION_ID} />);
    const mentions = screen.getAllByText(".companion/launch.json");
    expect(mentions.length).toBeGreaterThanOrEqual(1);
  });

  it("shows sandbox-specific empty state when no services configured in sandbox mode", () => {
    setupSandboxSession();
    render(<EnvironmentPanel sessionId={SESSION_ID} />);
    const emptyMessages = screen.getAllByText(/No services configured yet/i);
    expect(emptyMessages.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("button", { name: /open browser preview/i })).toHaveLength(2);
  });

  it("opens sandbox browser preview from empty-state CTA", () => {
    setupSandboxSession();
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    fireEvent.click(screen.getAllByRole("button", { name: /open browser preview/i })[0]);

    expect(useStore.getState().pendingBrowserUrl.get(SESSION_ID)).toBe("http://localhost:3000");
    expect(screen.getByTestId("session-browser-pane")).toBeInTheDocument();
  });

  // ─── Port rows render ─────────────────────────────────────────────────
  it("renders port rows with labels and port numbers", () => {
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
      { port: 5432, label: "Postgres", protocol: "tcp", status: "unknown" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText(":3000")).toBeInTheDocument();
    expect(screen.getByText("Postgres")).toBeInTheDocument();
    expect(screen.getByText(":5432")).toBeInTheDocument();
  });

  // ─── Service cards render ─────────────────────────────────────────────
  it("renders service cards with name and port", () => {
    setServiceStatuses([
      { name: "api", status: "ready", port: 3000 },
      { name: "worker", status: "starting" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
  });

  it("hydrates missing ports from the backend on mount", async () => {
    mockGetPortStatuses.mockResolvedValueOnce([
      { port: 3457, label: "Hono API", protocol: "http", status: "healthy" },
      { port: 5174, label: "Vite Dev Server", protocol: "http", status: "healthy" },
    ]);
    setServiceStatuses([
      { name: "api", status: "ready", port: 3457 },
      { name: "vite", status: "ready", port: 5174 },
    ]);

    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(screen.getByText("Hono API")).toBeInTheDocument();
      expect(screen.getByText("Vite Dev Server")).toBeInTheDocument();
    });
  });

  // ─── Empty browser state text ─────────────────────────────────────────
  it("shows empty browser message when ports exist but none selected", () => {
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);
    // Right panel should show the empty state
    expect(screen.getByText("Select a service or port to preview")).toBeInTheDocument();
  });

  // ─── Port click → iframe (local mode) ─────────────────────────────────
  it("opens iframe preview when clicking an HTTP port (local mode)", () => {
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    fireEvent.click(screen.getByText("App"));

    const iframe = screen.getByTitle("Environment preview");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute(
      "src",
      `/api/sessions/${SESSION_ID}/browser/host-proxy/3000/`,
    );
  });

  it("renders HTML preview responses correctly through the host proxy URL", () => {
    setPortStatuses([
      { port: 5174, label: "Vite Dev Server", protocol: "http", status: "healthy" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    fireEvent.click(screen.getByText("Vite Dev Server"));

    const iframe = screen.getByTitle("Environment preview");
    expect(iframe).toHaveAttribute(
      "src",
      `/api/sessions/${SESSION_ID}/browser/host-proxy/5174/`,
    );
  });

  // ─── TCP port → refresh instead of preview ────────────────────────────
  it("triggers health check refresh for TCP-only ports instead of opening preview", () => {
    mockCheckPort.mockResolvedValue({ status: "healthy" });
    setPortStatuses([
      { port: 5432, label: "Postgres", protocol: "tcp", status: "unknown" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    fireEvent.click(screen.getByText("Postgres"));

    expect(mockCheckPort).toHaveBeenCalledWith(SESSION_ID, 5432);
    // No iframe should appear for TCP ports
    expect(screen.queryByTitle("Environment preview")).not.toBeInTheDocument();
  });

  // ─── Sandbox mode: port click sets pending URL ────────────────────────
  it("sets pendingBrowserUrl when clicking port in sandbox mode", () => {
    setupSandboxSession();
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    fireEvent.click(screen.getByText("App"));

    // Should set pendingBrowserUrl for SessionBrowserPane to consume
    expect(useStore.getState().pendingBrowserUrl.get(SESSION_ID)).toBe("http://localhost:3000");
    // SessionBrowserPane should be rendered
    expect(screen.getByTestId("session-browser-pane")).toBeInTheDocument();
  });

  // ─── Custom URL input (local) ─────────────────────────────────────────
  it("navigates to custom URL when clicking Go (local mode)", () => {
    // Click a port first to get the BrowserPreview with URL bar
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);
    fireEvent.click(screen.getByText("App"));

    const input = screen.getByPlaceholderText("localhost:3000");
    fireEvent.change(input, { target: { value: "http://localhost:8080/dashboard" } });
    fireEvent.click(screen.getByText("Go"));

    const iframe = screen.getByTitle("Environment preview");
    expect(iframe).toHaveAttribute(
      "src",
      `/api/sessions/${SESSION_ID}/browser/host-proxy/8080/dashboard`,
    );
  });

  it("navigates to custom URL when pressing Enter", () => {
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);
    fireEvent.click(screen.getByText("App"));

    const input = screen.getByPlaceholderText("localhost:3000");
    fireEvent.change(input, { target: { value: "localhost:4000/api" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const iframe = screen.getByTitle("Environment preview");
    expect(iframe).toHaveAttribute(
      "src",
      `/api/sessions/${SESSION_ID}/browser/host-proxy/4000/api`,
    );
  });

  it("defaults to port 80 when no port is specified in URL", () => {
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);
    fireEvent.click(screen.getByText("App"));

    const input = screen.getByPlaceholderText("localhost:3000");
    fireEvent.change(input, { target: { value: "http://localhost/path" } });
    fireEvent.click(screen.getByText("Go"));

    const iframe = screen.getByTitle("Environment preview");
    expect(iframe).toHaveAttribute(
      "src",
      `/api/sessions/${SESSION_ID}/browser/host-proxy/80/path`,
    );
  });

  // ─── openOnReady auto-navigate ────────────────────────────────────────
  it("auto-opens port when it transitions to healthy and has openOnReady", () => {
    setPortStatuses([
      { port: 5173, label: "Vite", protocol: "http", status: "unhealthy", openOnReady: true },
    ]);
    const { rerender } = render(<EnvironmentPanel sessionId={SESSION_ID} />);

    // No iframe yet — port is unhealthy
    expect(screen.queryByTitle("Environment preview")).not.toBeInTheDocument();

    // Simulate port becoming healthy (local mode → host-proxy iframe)
    setPortStatuses([
      { port: 5173, label: "Vite", protocol: "http", status: "healthy", openOnReady: true },
    ]);
    rerender(<EnvironmentPanel sessionId={SESSION_ID} />);

    const iframe = screen.getByTitle("Environment preview");
    expect(iframe).toHaveAttribute("src", `/api/sessions/${SESSION_ID}/browser/host-proxy/5173/`);
  });

  it("does not auto-open port without openOnReady flag", () => {
    setPortStatuses([
      { port: 3000, label: "API", protocol: "http", status: "unhealthy" },
    ]);
    const { rerender } = render(<EnvironmentPanel sessionId={SESSION_ID} />);

    setPortStatuses([
      { port: 3000, label: "API", protocol: "http", status: "healthy" },
    ]);
    rerender(<EnvironmentPanel sessionId={SESSION_ID} />);

    expect(screen.queryByTitle("Environment preview")).not.toBeInTheDocument();
  });

  // ─── Port tooltip ─────────────────────────────────────────────────────
  it("shows correct tooltip with status and TCP info", () => {
    setPortStatuses([
      { port: 5432, label: "Postgres", protocol: "tcp", status: "unhealthy", service: "db" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    const portButton = screen.getByText("Postgres").closest("button");
    expect(portButton).toHaveAttribute("title", "Postgres (:5432) — unhealthy (db) (TCP)");
  });

  // ─── Reload config ────────────────────────────────────────────────────
  it("calls reloadLaunchConfig when clicking reload button", () => {
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    const reloadButton = screen.getByTitle("Reload .companion/launch.json");
    fireEvent.click(reloadButton);

    expect(mockReloadLaunchConfig).toHaveBeenCalledWith(SESSION_ID);
  });

  it("hydrates service logs without duplicating them on repeated mounts", async () => {
    mockGetServiceLogs.mockResolvedValue({ logs: ["first", "second"] });

    useStore.getState().setServiceLogs(SESSION_ID, "api", ["first", "second"]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    await waitFor(() => {
      expect(useStore.getState().serviceLogs.get(SESSION_ID)?.get("api")).toEqual(["first", "second"]);
    });
    expect(mockGetServiceLogs).not.toHaveBeenCalled();
  });

  it("keeps service restart loading state isolated per service", async () => {
    let resolveApi!: () => void;
    mockRestartService.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApi = () => resolve({ ok: true });
        }),
    );

    setServiceStatuses([
      { name: "api", status: "ready", port: 3000 },
      { name: "worker", status: "ready" },
    ]);
    render(<EnvironmentPanel sessionId={SESSION_ID} />);

    const restartButtons = screen.getAllByTitle(/restart /i);
    fireEvent.click(restartButtons[0]);

    expect(restartButtons[0]).toBeDisabled();
    expect(restartButtons[1]).not.toBeDisabled();

    resolveApi();
    await waitFor(() => {
      expect(restartButtons[0]).not.toBeDisabled();
    });
  });

  // ─── Accessibility ────────────────────────────────────────────────────
  it("passes accessibility scan (empty state)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<EnvironmentPanel sessionId={SESSION_ID} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (with ports and services)", async () => {
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
      { port: 5432, label: "Postgres", protocol: "tcp", status: "unknown" },
    ]);
    setServiceStatuses([
      { name: "api", status: "ready", port: 3000 },
    ]);
    const { axe } = await import("vitest-axe");
    const { container } = render(<EnvironmentPanel sessionId={SESSION_ID} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (with iframe preview)", async () => {
    setPortStatuses([
      { port: 3000, label: "App", protocol: "http", status: "healthy" },
    ]);
    const { axe } = await import("vitest-axe");
    const { container } = render(<EnvironmentPanel sessionId={SESSION_ID} />);

    fireEvent.click(screen.getByText("App"));

    // Remove iframe before axe — axe-core cannot inspect sandboxed iframes in jsdom
    const iframe = container.querySelector("iframe");
    iframe?.remove();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
