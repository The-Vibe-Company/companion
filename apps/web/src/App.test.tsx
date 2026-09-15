import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const config = { localAvailable: true, boxAvailable: true, model: "scripted/test" };
const me = { user: { id: "user-1", email: "stan@example.com", name: "Stan" } };
const ada = { id: "ada", name: "Ada", instructions: "Research", provider: "box", status: "ready", error: null, createdAt: "2026-09-11T09:00:00.000Z", avatar: { shape: 1, color: 2, face: 0 } };
const discussion = { id: "discussion-1", title: "Launch", folderId: null, directCompanionId: null, archivedAt: null, createdAt: "2026-09-11T09:00:00.000Z", updatedAt: "2026-09-11T09:00:00.000Z" };
function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); }

describe("App discussion routing", () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each([["/about", "Your AI companions. Give them something to do."], ["/privacy", "Privacy Policy"], ["/terms", "Terms of Use"]])("serves %s without authentication", (path, heading) => {
    window.history.replaceState({}, "", path); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); render(<App/>); expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the latest persisted discussion from the root", async () => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => { const path = String(input); if (path === "/api/me") return response(me); if (path === "/api/config") return response(config); if (path === "/api/companions") return response({ companions: [ada] }); if (path === "/api/discussions") return response({ discussions: [discussion], folders: [] }); if (path === "/api/discussions/discussion-1") return response({ discussion, participants: [], messages: [], tasks: [], centralRuns: [], proposals: [], beforeCursor: null }); throw Error(`Unexpected ${path}`); }));
    render(<App/>); expect(await screen.findByRole("heading", { name: "Launch" })).toBeInTheDocument(); expect(window.location.pathname).toBe("/discussions/discussion-1"); expect(screen.getByRole("textbox", { name: "Message Companion" })).toBeInTheDocument();
  });

  it("redirects a legacy companion route to its latest direct discussion", async () => {
    window.history.replaceState({}, "", "/companions/ada"); const direct = { ...discussion, id: "direct-1", title: "Ada", directCompanionId: "ada" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => { const path = String(input); if (path === "/api/me") return response(me); if (path === "/api/config") return response(config); if (path === "/api/companions") return response({ companions: [ada] }); if (path === "/api/discussions") return response({ discussions: [direct], folders: [] }); if (path === "/api/companions/ada/discussions") return response({ discussions: [direct] }); if (path === "/api/discussions/direct-1") return response({ discussion: direct, participants: [{ companionId: "ada", removedAt: null, companion: ada }], messages: [], tasks: [], centralRuns: [], proposals: [], beforeCursor: null }); throw Error(`Unexpected ${path}`); }));
    render(<App/>); await waitFor(() => expect(window.location.pathname).toBe("/discussions/direct-1")); expect(await screen.findByRole("textbox", { name: "Message Ada" })).toBeInTheDocument();
  });
});


describe("settings and return navigation", () => {
  beforeEach(() => { sessionStorage.clear(); window.history.replaceState({}, "", "/discussions/discussion-1"); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  function installApi() {
    let current = { ...ada };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me") return response(me);
      if (path === "/api/config") return response({ ...config, models: [] });
      if (path === "/api/companions") return response({ companions: [current] });
      if (path === "/api/companions/ada") {
        if (init?.method === "PATCH") current = { ...current, ...JSON.parse(String(init.body)) };
        return response({ companion: current });
      }
      if (path === "/api/plugins") return response({ accounts: [], catalog: [] });
      if (path === "/api/companions/ada/plugins") return response({ accounts: [] });
      if (path === "/api/discussions") return response({ discussions: [discussion], folders: [] });
      if (path === "/api/discussions/discussion-1") return response({ discussion, participants: [], messages: [], tasks: [], centralRuns: [], proposals: [], beforeCursor: null });
      throw Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  it("opens settings without creating a direct discussion, saves, and returns to the previous draft", async () => {
    const fetchMock = installApi(); render(<App/>);
    const composer = await screen.findByRole("textbox", { name: "Message Companion" });
    fireEvent.change(composer, { target: { value: "Keep this idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Options for Ada" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings for Ada" }));
    expect(await screen.findByRole("heading", { name: "Ada settings" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/companions/ada/settings");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Ada Research" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Ada Research settings" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to discussions" }));
    expect(await screen.findByRole("textbox", { name: "Message Companion" })).toHaveValue("Keep this idea");
    expect(window.location.pathname).toBe("/discussions/discussion-1");
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).includes("discussions") && init?.method === "POST")).toBe(false);
  });
  it("loads a settings deep link without touching discussions", async () => {
    window.history.replaceState({}, "", "/companions/ada/settings");
    const fetchMock = installApi(); render(<App/>);
    expect(await screen.findByRole("heading", { name: "Ada settings" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("discussions"))).toBe(false);
  });
  it("uses the logo for navigation without creating work", async () => {
    const fetchMock = installApi(); render(<App/>);
    await screen.findByRole("heading", { name: "Launch" });
    fireEvent.click(screen.getByRole("button", { name: "Back to discussions" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
