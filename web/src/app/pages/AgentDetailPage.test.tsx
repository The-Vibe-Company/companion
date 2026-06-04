/**
 * AgentDetailPage tests.
 *
 * The network is mocked at the client boundary (vi.mock("../../api/client")),
 * so these assert real page behavior — rendered data, loading/error states, and
 * the gating + arguments of every mutating flow — without a live server.
 *
 * The page renders inside a MemoryRouter seeded at "/agents/:id" with a matching
 * route so useParams("id") and useNavigate work as in production.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AgentDetailPage from "./AgentDetailPage";
import type {
  AgentDetail,
  ApplyResponse,
  LogsResponse,
  OperationStatus,
  PlanResponse,
} from "../../api/types";

// --- Mock the typed console client at its module boundary ------------------
// We replace the network-calling functions with spies but keep the real
// ConsoleError class (the page + tests use `instanceof`/`.message`). getStatus
// is provided because the hooks module imports it at eval time (unused here).
vi.mock("../../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ConsoleError: actual.ConsoleError,
    getAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    getAgentLogs: vi.fn(),
    plan: vi.fn(),
    apply: vi.fn(),
    // Used by useOperation/OperationProgress once an apply starts.
    getOperation: vi.fn(),
    getStatus: vi.fn(),
  };
});

import * as client from "../../api/client";

const mockGetAgent = vi.mocked(client.getAgent);
const mockUpdateAgent = vi.mocked(client.updateAgent);
const mockDeleteAgent = vi.mocked(client.deleteAgent);
const mockGetAgentLogs = vi.mocked(client.getAgentLogs);
const mockPlan = vi.mocked(client.plan);
const mockApply = vi.mocked(client.apply);
const mockGetOperation = vi.mocked(client.getOperation);

const AGENT_ID = "research-agent";

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: AGENT_ID,
    model: "anthropic/claude-3.5-sonnet",
    fly_app: "research-agent",
    tailscale_hostname: "research-agent",
    vault: "memory",
    lifecycle: "present",
    health: "ok",
    fly_state: "started",
    url: "https://research-agent.example.ts.net",
    last_deploy: "2026-06-01T12:00:00Z",
    region: "cdg",
    memory: "512mb",
    cpus: 1,
    runtime: "fly.default",
    network: "tailscale.default",
    model_provider: "openrouter.default",
    soul_preview: "# Identity\nYou are a focused research agent.",
    companion_soul_enabled: true,
    vault_connections: ["shared-research", "team-notes"],
    ...overrides,
  };
}

function makeLogs(overrides: Partial<LogsResponse> = {}): LogsResponse {
  return {
    agent_id: AGENT_ID,
    lines: ["2026-06-01 deploy succeeded", "2026-06-02 health ok"],
    source: "state-events",
    note: "Live Fly/agent task logs are a later Hermes feature.",
    ...overrides,
  };
}

/** Renders the page at /agents/:id with a matching route. */
function renderPage(id = AGENT_ID) {
  return render(
    <MemoryRouter initialEntries={[`/agents/${id}`]}>
      <Routes>
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/" element={<div>Agents list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// jsdom implements <dialog> but not its modal methods, which ConfirmDialog
// drives. Polyfill showModal/close to toggle the `open` property so the dialog
// mounts and is queryable as a real modal in tests.
beforeEach(() => {
  const proto = window.HTMLDialogElement.prototype;
  if (!proto.showModal) {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!proto.close) {
    proto.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible default happy-path resolutions; individual tests override.
  mockGetAgent.mockResolvedValue(makeAgent());
  mockGetAgentLogs.mockResolvedValue(makeLogs());
});

describe("AgentDetailPage", () => {
  it("renders the loaded agent's status, config and granite settings", async () => {
    renderPage();

    // Heading shows the id (in the PageHeader h1).
    expect(
      await screen.findByRole("heading", { level: 1, name: AGENT_ID }),
    ).toBeInTheDocument();

    // Status facts.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("started")).toBeInTheDocument();

    // External URL link.
    const link = screen.getByRole("link", {
      name: /research-agent\.example\.ts\.net/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://research-agent.example.ts.net",
    );

    // Edit form is seeded from the detail (model populated, id read-only).
    expect(screen.getByLabelText(/^model$/i)).toHaveValue(
      "anthropic/claude-3.5-sonnet",
    );
    expect(screen.getByLabelText(/agent id/i)).toHaveAttribute("readonly");

    // SOUL.md preview is shown read-only (CodeBlock group).
    expect(
      screen.getByText(/you are a focused research agent/i),
    ).toBeInTheDocument();

    // Granite: companion soul enabled + read-only vault connections.
    expect(screen.getByText("enabled")).toBeInTheDocument();
    expect(screen.getByText("shared-research")).toBeInTheDocument();
    expect(screen.getByText("team-notes")).toBeInTheDocument();
  });

  it("shows a spinner while the agent is loading", () => {
    // A never-resolving promise keeps the page in its loading state.
    mockGetAgent.mockReturnValue(new Promise<AgentDetail>(() => {}));
    renderPage();
    expect(
      screen.getByText(new RegExp(`loading ${AGENT_ID}`, "i")),
    ).toBeInTheDocument();
  });

  it("surfaces a load error with a retry that re-fetches", async () => {
    const err = new client.ConsoleError(500, "boom");
    mockGetAgent.mockRejectedValueOnce(err);
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("boom")).toBeInTheDocument();

    // Retry triggers a second getAgent; the happy-path default now resolves.
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(
      await screen.findByRole("heading", { level: 1, name: AGENT_ID }),
    ).toBeInTheDocument();
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
  });

  it("renders recent activity lines and the offline note", async () => {
    renderPage();
    expect(
      await screen.findByText(/2026-06-01 deploy succeeded/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/live fly\/agent task logs are a later hermes feature/i),
    ).toBeInTheDocument();
  });

  it("shows an empty state when there are no recent events", async () => {
    mockGetAgentLogs.mockResolvedValue(makeLogs({ lines: [] }));
    renderPage();
    expect(await screen.findByText(/no recent events/i)).toBeInTheDocument();
  });

  it("saves edits via updateAgent with the agent id and edited fields", async () => {
    const user = userEvent.setup();
    mockUpdateAgent.mockResolvedValue(makeAgent());
    renderPage();

    // Wait for the form, then change the memory and save.
    const memory = await screen.findByLabelText(/^memory$/i);
    await user.clear(memory);
    await user.type(memory, "1gb");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const [calledId, input] = mockUpdateAgent.mock.calls[0];
    expect(calledId).toBe(AGENT_ID);
    expect(input).toMatchObject({
      id: AGENT_ID,
      model: "anthropic/claude-3.5-sonnet",
      memory: "1gb",
      companion_soul_enabled: true,
      // soul is intentionally blank so the existing SOUL.md is preserved.
      soul: "",
    });

    // Success confirmation appears.
    expect(
      await screen.findByText(/saved\. run plan & apply below/i),
    ).toBeInTheDocument();
  });

  it("surfaces a save error and does not navigate away", async () => {
    const user = userEvent.setup();
    mockUpdateAgent.mockRejectedValue(new client.ConsoleError(400, "bad model"));
    renderPage();

    await screen.findByRole("button", { name: /save changes/i });
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText("bad model")).toBeInTheDocument();
    // Still on the detail page (heading present).
    expect(
      screen.getByRole("heading", { level: 1, name: AGENT_ID }),
    ).toBeInTheDocument();
  });

  it("plans, shows the diff, and gates apply behind a confirm dialog", async () => {
    const user = userEvent.setup();
    const planResp: PlanResponse = {
      hash: "sha256:abc123",
      text: "~ fly_app.research-agent",
      changes: [
        {
          kind: "~",
          action: "update",
          address: "fly_app.research-agent",
          message: "memory 512mb -> 1gb",
          protected: false,
        },
      ],
    };
    mockPlan.mockResolvedValue(planResp);
    const applyResp: ApplyResponse = { operation_id: "op-1" };
    mockApply.mockResolvedValue(applyResp);
    const op: OperationStatus = {
      id: "op-1",
      state: "succeeded",
      changed_resources: ["fly_app.research-agent"],
    };
    mockGetOperation.mockResolvedValue(op);

    renderPage();

    // Trigger a plan.
    await user.click(await screen.findByRole("button", { name: /plan changes/i }));

    // The diff renders the change address; apply is now available but NOT yet
    // called — it must go through the confirm dialog first.
    expect(
      await screen.findByText("fly_app.research-agent"),
    ).toBeInTheDocument();
    expect(mockApply).not.toHaveBeenCalled();

    // Click Apply -> opens the confirm dialog (still no apply call).
    await user.click(screen.getByRole("button", { name: /^apply$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/apply planned changes\?/i),
    ).toBeInTheDocument();
    expect(mockApply).not.toHaveBeenCalled();

    // Confirm inside the dialog -> apply(hash) is finally called with the hash.
    await user.click(within(dialog).getByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith("sha256:abc123");

    // OperationProgress polls getOperation and shows the changed resource.
    await waitFor(() => expect(mockGetOperation).toHaveBeenCalledWith("op-1"));
  });

  it("does not offer apply when the plan has no changes", async () => {
    const user = userEvent.setup();
    mockPlan.mockResolvedValue({ hash: "h", text: "", changes: [] });
    renderPage();

    await user.click(await screen.findByRole("button", { name: /plan changes/i }));

    // Empty diff state appears; no enabled Apply button exists.
    expect(await screen.findByText(/no changes/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^apply$/i }),
    ).toBeNull();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("deletes (marks absent) only after confirming, calling deleteAgent", async () => {
    const user = userEvent.setup();
    mockDeleteAgent.mockResolvedValue(makeAgent({ lifecycle: "absent" }));
    renderPage();

    // Open the delete confirm; deleteAgent must not be called yet.
    await user.click(await screen.findByRole("button", { name: /delete agent/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/mark agent absent\?/i),
    ).toBeInTheDocument();
    expect(mockDeleteAgent).not.toHaveBeenCalled();

    // Confirm -> deleteAgent(id) and navigation back to the list.
    await user.click(within(dialog).getByRole("button", { name: /mark absent/i }));
    await waitFor(() => expect(mockDeleteAgent).toHaveBeenCalledWith(AGENT_ID));
    expect(await screen.findByText("Agents list")).toBeInTheDocument();
  });

  it("can cancel the delete without calling deleteAgent", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /delete agent/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mockDeleteAgent).not.toHaveBeenCalled();
  });
});
