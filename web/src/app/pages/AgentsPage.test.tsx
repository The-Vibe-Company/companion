/**
 * AgentsPage tests.
 *
 * The network is mocked at the client boundary (`vi.mock("../../api/client")`)
 * so no real console server or status poller is contacted. We assert on
 * behavior a user/screen-reader perceives: the agents table renders with
 * lifecycle/health/url, each row links to the detail route, the live status
 * snapshot enriches rows by id, support services render in their own section,
 * and the loading / empty / error states each appear when they should. The
 * error state's retry must re-invoke the list fetch.
 */

import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AgentsPage from "./AgentsPage";
import type { AgentSummary, StatusSnapshot } from "../../api/types";

// Mock the entire client module: the page calls listAgents() and useStatus()
// (which calls getStatus()). getOperation is exported only so the hooks module's
// import resolves under the mock; it is unused by this page.
vi.mock("../../api/client", () => ({
  listAgents: vi.fn(),
  getStatus: vi.fn(),
  getOperation: vi.fn(),
}));

import { listAgents, getStatus } from "../../api/client";

const mockListAgents = listAgents as unknown as Mock;
const mockGetStatus = getStatus as unknown as Mock;

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "atlas",
    model: "anthropic/claude-3.5-sonnet",
    fly_app: "atlas-app",
    tailscale_hostname: "atlas",
    vault: "atlas-vault",
    lifecycle: "present",
    ...over,
  };
}

function emptySnapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    workspace: "minimal",
    generated_at: "2026-06-04T00:00:00Z",
    services: [],
    drift_count: 0,
    summary: { total: 0, healthy: 0, degraded: 0, down: 0 },
    ...over,
  };
}

/** A status snapshot that never resolves keeps the page in its loading state. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a calm, empty status snapshot so useStatus resolves without error.
  mockGetStatus.mockResolvedValue(emptySnapshot());
});

describe("AgentsPage", () => {
  it("shows a loading state before the agents arrive", async () => {
    mockListAgents.mockReturnValue(pending<AgentSummary[]>());
    renderPage();

    expect(await screen.findByText(/loading agents/i)).toBeInTheDocument();
    // No table is rendered yet while the first load is in flight.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a row per agent with lifecycle, health, model and a detail link", async () => {
    mockListAgents.mockResolvedValue([
      agent({
        id: "atlas",
        lifecycle: "present",
        health: "ok",
        fly_state: "started",
        model: "anthropic/claude-3.5-sonnet",
        vault: "atlas-vault",
        url: "https://atlas.example.ts.net",
        last_deploy: "2026-06-01T12:00:00Z",
      }),
      agent({ id: "boreas", lifecycle: "absent", vault: "" }),
    ]);
    renderPage();

    // Both agents render as rows.
    const atlasLink = await screen.findByRole("link", { name: "atlas" });
    expect(atlasLink).toHaveAttribute("href", "/agents/atlas");
    const boreasLink = screen.getByRole("link", { name: "boreas" });
    expect(boreasLink).toHaveAttribute("href", "/agents/boreas");

    // Row content: lifecycle, health badge, fly_state, model.
    const atlasRow = atlasLink.closest("tr")!;
    expect(within(atlasRow).getByText("present")).toBeInTheDocument();
    expect(within(atlasRow).getByText("Healthy")).toBeInTheDocument();
    expect(within(atlasRow).getByText("started")).toBeInTheDocument();
    expect(
      within(atlasRow).getByText("anthropic/claude-3.5-sonnet"),
    ).toBeInTheDocument();

    // The Tailscale URL renders as an external link showing the host.
    const urlLink = within(atlasRow).getByRole("link", {
      name: "atlas.example.ts.net",
    });
    expect(urlLink).toHaveAttribute("href", "https://atlas.example.ts.net");

    // The absent agent surfaces its lifecycle distinctly.
    const boreasRow = boreasLink.closest("tr")!;
    expect(within(boreasRow).getByText("absent")).toBeInTheDocument();
  });

  it("enriches an agent row's health/fly_state/url from the status snapshot by id", async () => {
    // The list row lacks live fields; the snapshot supplies them by matching id.
    mockListAgents.mockResolvedValue([agent({ id: "atlas" })]);
    mockGetStatus.mockResolvedValue(
      emptySnapshot({
        services: [
          {
            id: "atlas",
            kind: "agent",
            health: "degraded",
            online: true,
            machine_state: "stopped",
            url: "https://atlas.snapshot.ts.net",
          },
        ],
      }),
    );
    renderPage();

    const atlasRow = (await screen.findByRole("link", { name: "atlas" })).closest(
      "tr",
    )!;
    // Health + fly_state came from the snapshot, not the (bare) list row.
    expect(within(atlasRow).getByText("Degraded")).toBeInTheDocument();
    expect(within(atlasRow).getByText("stopped")).toBeInTheDocument();
    expect(
      within(atlasRow).getByRole("link", { name: "atlas.snapshot.ts.net" }),
    ).toHaveAttribute("href", "https://atlas.snapshot.ts.net");
  });

  it("lists support services from the snapshot in their own section, not as agents", async () => {
    mockListAgents.mockResolvedValue([agent({ id: "atlas" })]);
    mockGetStatus.mockResolvedValue(
      emptySnapshot({
        services: [
          { id: "atlas", kind: "agent", health: "ok", online: true },
          {
            id: "fleet-webui",
            kind: "openwebui",
            health: "ok",
            online: true,
            url: "https://webui.example.ts.net",
          },
        ],
      }),
    );
    renderPage();

    // The support section is a labelled region containing the Open WebUI row.
    const section = await screen.findByRole("region", {
      name: /support services/i,
    });
    expect(within(section).getByText("fleet-webui")).toBeInTheDocument();
    expect(within(section).getByText("Open WebUI")).toBeInTheDocument();
    expect(
      within(section).getByRole("link", { name: "webui.example.ts.net" }),
    ).toHaveAttribute("href", "https://webui.example.ts.net");

    // The agent-kind service did NOT leak into the support section.
    expect(within(section).queryByText("atlas")).not.toBeInTheDocument();
  });

  it("renders an empty state with a create call-to-action when there are no agents", async () => {
    mockListAgents.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/no agents yet/i)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /create an agent/i });
    expect(cta).toHaveAttribute("href", "/agents/new");
    // No table in the empty case.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an error banner with a working retry when the list fails", async () => {
    mockListAgents
      .mockRejectedValueOnce(new Error("boom: agents unavailable"))
      .mockResolvedValueOnce([agent({ id: "atlas" })]);
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/boom: agents unavailable/i)).toBeInTheDocument();
    expect(mockListAgents).toHaveBeenCalledTimes(1);

    // Retrying re-invokes the fetch and recovers to the table.
    await userEvent.click(within(alert).getByRole("button", { name: /retry/i }));

    expect(await screen.findByRole("link", { name: "atlas" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockListAgents).toHaveBeenCalledTimes(2);
  });

  it("always offers a New agent action that navigates to the create route", async () => {
    mockListAgents.mockResolvedValue([agent({ id: "atlas" })]);
    renderPage();

    // Wait for content so the header action is settled.
    await screen.findByRole("link", { name: "atlas" });
    expect(
      screen.getByRole("link", { name: /new agent/i }),
    ).toHaveAttribute("href", "/agents/new");
  });
});
