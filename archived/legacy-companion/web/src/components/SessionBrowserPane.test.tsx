// @vitest-environment jsdom
/**
 * Tests for the SessionBrowserPane component.
 *
 * Validates:
 * - Loading state while display stack starts
 * - Host mode: toolbar shown immediately, proxy URL navigation
 * - Container mode: noVNC iframe, xdotool navigation
 * - Error states (API unavailable, network error)
 * - Auth token injection for remote WS connections
 * - Reload button refreshes the iframe
 * - Accessibility (axe scan)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockStartBrowser = vi.fn();
const mockNavigateBrowser = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    startBrowser: (...args: unknown[]) => mockStartBrowser(...args),
    navigateBrowser: (...args: unknown[]) => mockNavigateBrowser(...args),
  },
}));

import { SessionBrowserPane } from "./SessionBrowserPane.js";

beforeEach(() => {
  mockStartBrowser.mockReset();
  mockNavigateBrowser.mockReset();
});

afterEach(() => {
  // Clean up localStorage to prevent test leaks (e.g. companion_auth_token
  // set during auth token injection tests). Using afterEach ensures cleanup
  // runs even if an assertion throws.
  localStorage.removeItem("companion_auth_token");
});

describe("SessionBrowserPane", () => {
  // ─── Render / loading state ───────────────────────────────────────────
  it("shows loading state initially", () => {
    // startBrowser never resolves so loading spinner stays visible
    mockStartBrowser.mockReturnValue(new Promise(() => {}));
    render(<SessionBrowserPane sessionId="s1" />);
    expect(screen.getByText("Starting browser preview...")).toBeInTheDocument();
  });

  // ─── Host mode ──────────────────────────────────────────────────────
  it("shows toolbar with placeholder text in host mode", async () => {
    // Server returns host mode — no VNC, just proxy-based iframe
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });
    // Toolbar elements should be present
    expect(screen.getByLabelText("Navigate URL")).toBeInTheDocument();
    expect(screen.getByText("Go")).toBeInTheDocument();
    expect(screen.getByLabelText("Reload browser")).toBeInTheDocument();
  });

  it("constructs proxy URL when navigating in host mode", async () => {
    // Host mode: frontend builds /api/sessions/:id/browser/host-proxy/:port/path
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "http://localhost:8080/dashboard" } });
    fireEvent.click(screen.getByText("Go"));

    // Should render iframe with proxy URL — no backend navigateBrowser call
    await waitFor(() => {
      const iframe = screen.getByTitle("Browser preview");
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute("src", "/api/sessions/s1/browser/host-proxy/8080/dashboard");
    });
    expect(mockNavigateBrowser).not.toHaveBeenCalled();
  });

  it("uses default port 80 for http URLs without explicit port", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "http://localhost/path" } });
    fireEvent.click(screen.getByText("Go"));

    await waitFor(() => {
      const iframe = screen.getByTitle("Browser preview");
      expect(iframe).toHaveAttribute("src", "/api/sessions/s1/browser/host-proxy/80/path");
    });
  });

  it("preserves query string without doubling in host mode", async () => {
    // Regression test: query string should appear once in the proxy URL, not twice
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "http://localhost:3000/api?q=hello" } });
    fireEvent.click(screen.getByText("Go"));

    await waitFor(() => {
      const iframe = screen.getByTitle("Browser preview");
      // Query string should be appended once, not embedded in the path
      expect(iframe).toHaveAttribute("src", "/api/sessions/s1/browser/host-proxy/3000/api?q=hello");
    });
  });

  it("shows error for invalid URL in host mode", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByText("Go"));

    expect(screen.getByText("Invalid URL")).toBeInTheDocument();
  });

  it("rejects non-http URL schemes in host mode", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "ftp://files.example.com" } });
    fireEvent.click(screen.getByText("Go"));

    expect(screen.getByText("Only http:// and https:// URLs are supported")).toBeInTheDocument();
  });

  it("rejects non-localhost hostnames in host mode", async () => {
    // Host mode only proxies localhost — remote hostnames are not supported
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "http://example.com/path" } });
    fireEvent.click(screen.getByText("Go"));

    expect(screen.getByText("Host mode only supports localhost URLs (e.g. http://localhost:3000)")).toBeInTheDocument();
  });

  // ─── API returns unavailable ──────────────────────────────────────────
  it("shows error when API returns unavailable", async () => {
    mockStartBrowser.mockResolvedValue({
      available: false,
      mode: "container",
      message: "Xvfb not installed",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Xvfb not installed")).toBeInTheDocument();
    });
  });

  // ─── API error ────────────────────────────────────────────────────────
  it("shows error when API call throws", async () => {
    mockStartBrowser.mockRejectedValue(new Error("Network error"));
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  // ─── Successful container iframe rendering ────────────────────────────
  it("renders iframe when API returns a container URL", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "container",
      url: "/api/sessions/s1/browser/proxy/vnc.html?autoconnect=true",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      const iframe = screen.getByTitle("Browser preview");
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute("src", "/api/sessions/s1/browser/proxy/vnc.html?autoconnect=true");
    });
  });

  // ─── Auth token injection ────────────────────────────────────────────
  it("injects auth token into noVNC WebSocket path for remote server support", async () => {
    // Simulate an auth token being stored (as happens on remote deployments)
    localStorage.setItem("companion_auth_token", "test-secret-token");
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "container",
      url: "/api/sessions/s1/browser/proxy/vnc.html?autoconnect=true&resize=scale&path=ws/novnc/s1",
    });
    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      const iframe = screen.getByTitle("Browser preview");
      expect(iframe).toBeInTheDocument();
      // The path parameter should now include the token so noVNC forwards it on WS connect
      expect(iframe.getAttribute("src")).toContain("path=ws%2Fnovnc%2Fs1%3Ftoken%3Dtest-secret-token");
    });
  });

  // ─── Container navigation ────────────────────────────────────────────
  it("calls navigateBrowser when pressing Enter in container mode", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "container",
      url: "/api/sessions/s1/browser/proxy/vnc.html",
    });
    mockNavigateBrowser.mockResolvedValue({ ok: true });

    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "http://localhost:8080" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockNavigateBrowser).toHaveBeenCalledWith("s1", "http://localhost:8080");
  });

  it("calls navigateBrowser when clicking Go in container mode", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "container",
      url: "/api/sessions/s1/browser/proxy/vnc.html",
    });
    mockNavigateBrowser.mockResolvedValue({ ok: true });

    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "http://localhost:5000" } });
    fireEvent.click(screen.getByText("Go"));

    expect(mockNavigateBrowser).toHaveBeenCalledWith("s1", "http://localhost:5000");
  });

  // ─── Navigation error feedback ────────────────────────────────────────
  it("shows error banner when container navigation fails", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "container",
      url: "/api/sessions/s1/browser/proxy/vnc.html",
    });
    mockNavigateBrowser.mockRejectedValue(new Error("Container stopped"));

    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toBeInTheDocument();
    });

    const input = screen.getByLabelText("Navigate URL");
    fireEvent.change(input, { target: { value: "http://localhost:3000" } });
    fireEvent.click(screen.getByText("Go"));

    await waitFor(() => {
      expect(screen.getByText("Container stopped")).toBeInTheDocument();
    });

    // Dismiss the error
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByText("Container stopped")).not.toBeInTheDocument();
  });

  // ─── Reload button ────────────────────────────────────────────────────
  it("reload button resets iframe src", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "container",
      url: "/api/sessions/s1/browser/proxy/vnc.html",
    });

    render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toBeInTheDocument();
    });

    const reloadBtn = screen.getByLabelText("Reload browser");
    // Click reload — the iframe src should be re-assigned
    fireEvent.click(reloadBtn);
    // The iframe should still have the same src (re-assigned)
    expect(screen.getByTitle("Browser preview")).toHaveAttribute(
      "src",
      "/api/sessions/s1/browser/proxy/vnc.html",
    );
  });

  // ─── Accessibility ────────────────────────────────────────────────────
  it("passes accessibility scan (loading state)", async () => {
    mockStartBrowser.mockReturnValue(new Promise(() => {}));
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionBrowserPane sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (container active state with toolbar)", async () => {
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "container",
      url: "/api/sessions/s1/browser/proxy/vnc.html",
    });
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toBeInTheDocument();
    });
    // Remove the iframe before axe scan — axe-core cannot inspect sandboxed
    // iframes in jsdom and throws "Respondable target" errors. The toolbar
    // and surrounding structure are still scanned for a11y compliance.
    const iframe = container.querySelector("iframe");
    iframe?.remove();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (host mode with placeholder)", async () => {
    // Host mode shows toolbar + placeholder text (no iframe yet)
    mockStartBrowser.mockResolvedValue({
      available: true,
      mode: "host",
    });
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes accessibility scan (error state)", async () => {
    mockStartBrowser.mockResolvedValue({
      available: false,
      mode: "container",
      message: "Xvfb not installed",
    });
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionBrowserPane sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText("Xvfb not installed")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
