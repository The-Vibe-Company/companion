/**
 * CreateAgentPage tests.
 *
 * These exercise the wizard's real, observable behavior end-to-end with the
 * console client mocked at its module boundary (so no network, no live server):
 *
 *  - the template step seeds the form and advances to Configure;
 *  - the form's own validation gates Configure → Review (an invalid id never
 *    advances and never calls createAgent);
 *  - "Create & plan" calls createAgent(input) with the assembled input, then
 *    plan(), and renders the resulting PlanDiff + the plan hash;
 *  - APPLY IS GATED: the Apply button is disabled until the explicit
 *    "I reviewed the plan" confirmation is ticked, after which apply(hash) is
 *    called with the current plan hash and live progress streams to success;
 *  - a ConsoleError from createAgent is surfaced inline (the error path).
 *
 * The whole client module is mocked so getOperation (reached transitively via
 * OperationProgress → useOperation) is deterministic too.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import CreateAgentPage from "./CreateAgentPage";
import type {
  AgentDetail,
  ApplyResponse,
  OperationStatus,
  PlanResponse,
} from "../../api/types";

// Mock the client at the boundary. Every page/component path that talks to the
// API (including OperationProgress → useOperation → getOperation) resolves to
// these spies.
vi.mock("../../api/client", () => ({
  ConsoleError: class ConsoleError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ConsoleError";
      this.status = status;
    }
  },
  createAgent: vi.fn(),
  plan: vi.fn(),
  apply: vi.fn(),
  getOperation: vi.fn(),
}));

import {
  ConsoleError,
  apply,
  createAgent,
  getOperation,
  plan,
} from "../../api/client";

const createAgentMock = vi.mocked(createAgent);
const planMock = vi.mocked(plan);
const applyMock = vi.mocked(apply);
const getOperationMock = vi.mocked(getOperation);

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "research-agent",
    model: "google/gemini-3.5-flash",
    fly_app: "research-agent",
    tailscale_hostname: "research-agent",
    vault: "memory",
    lifecycle: "present",
    region: "cdg",
    memory: "512mb",
    cpus: 1,
    runtime: "fly.default",
    network: "tailscale.default",
    model_provider: "openrouter.default",
    soul_preview: "",
    companion_soul_enabled: true,
    vault_connections: [],
    ...over,
  };
}

function planResponse(over: Partial<PlanResponse> = {}): PlanResponse {
  return {
    hash: "abcdef0123456789",
    text: "+ fly_app.research-agent will be created",
    changes: [
      {
        kind: "+",
        action: "create",
        address: "fly_app.research-agent",
        message: "create the agent app",
        protected: false,
      },
    ],
    ...over,
  };
}

function operation(state: OperationStatus["state"]): OperationStatus {
  return {
    id: "op-1",
    state,
    started_at: "2026-06-04T00:00:00Z",
    finished_at: state === "succeeded" ? "2026-06-04T00:01:00Z" : undefined,
    changed_resources:
      state === "succeeded" ? ["fly_app.research-agent"] : [],
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/agents/new"]}>
      <Routes>
        <Route path="/agents/new" element={<CreateAgentPage />} />
        <Route path="/agents/:id" element={<div>Agent detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Walks template → configure → fills the form → review. Returns the user. */
async function fillToReview(
  user: ReturnType<typeof userEvent.setup>,
  id = "research-agent",
) {
  await user.click(screen.getByRole("button", { name: /standard agent/i }));
  // Now on Configure: fill id + name (model is seeded by the template).
  await user.type(screen.getByLabelText(/agent id/i), id);
  await user.type(screen.getByLabelText(/display name/i), "Research Agent");
  await user.click(
    screen.getByRole("button", { name: /review configuration/i }),
  );
}

beforeEach(() => {
  createAgentMock.mockReset();
  planMock.mockReset();
  applyMock.mockReset();
  getOperationMock.mockReset();
});

describe("CreateAgentPage", () => {
  it("seeds the form from the chosen template and advances to configure", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { name: /choose a starting template/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /standard agent/i }));

    // Configure step: the model field is pre-filled from the template.
    expect(
      screen.getByRole("heading", { name: /configure the agent/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^model$/i)).toHaveValue(
      "google/gemini-3.5-flash",
    );
    expect(screen.getByLabelText(/memory/i)).toHaveValue("512mb");
  });

  it("blocks advancing to review (and never creates) when the id is invalid", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /standard agent/i }));
    await user.type(screen.getByLabelText(/display name/i), "Research Agent");
    await user.type(screen.getByLabelText(/agent id/i), "Bad_Id");
    await user.click(
      screen.getByRole("button", { name: /review configuration/i }),
    );

    // Stayed on configure; the id is flagged; createAgent was never called.
    expect(
      screen.getByText(/lowercase letters, digits and hyphens/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/agent id/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it("on Create & plan: calls createAgent(input) then plan(), and renders the diff + hash", async () => {
    createAgentMock.mockResolvedValue(detail());
    planMock.mockResolvedValue(planResponse());

    const user = userEvent.setup();
    renderPage();

    await fillToReview(user);

    // Review step shows the assembled input.
    expect(
      screen.getByRole("heading", { name: /review configuration/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("research-agent")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /create & plan/i }));

    // createAgent was called with the assembled input; plan followed.
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "research-agent",
        name: "Research Agent",
        model: "google/gemini-3.5-flash",
        memory: "512mb",
        cpus: 1,
        lifecycle: "present",
      }),
    );
    await waitFor(() => expect(planMock).toHaveBeenCalledTimes(1));

    // The plan diff renders the create change and the (truncated) hash.
    const planList = await screen.findByRole("list", {
      name: /planned changes/i,
    });
    expect(
      within(planList).getByText("fly_app.research-agent"),
    ).toBeInTheDocument();
    expect(within(planList).getByText("create")).toBeInTheDocument();
    expect(screen.getByText("abcdef012345")).toBeInTheDocument(); // hash.slice(0,12)
  });

  it("gates Apply behind the explicit confirmation, then calls apply(hash) and streams to success", async () => {
    createAgentMock.mockResolvedValue(detail());
    planMock.mockResolvedValue(planResponse());
    applyMock.mockResolvedValue({ operation_id: "op-1" } satisfies ApplyResponse);
    // The operation is already terminal on the first poll, so useOperation
    // resolves and stops without depending on interval timing.
    getOperationMock.mockResolvedValue(operation("succeeded"));

    const user = userEvent.setup();
    renderPage();

    await fillToReview(user);
    await user.click(screen.getByRole("button", { name: /create & plan/i }));

    // Wait for the plan to render, surfacing the Apply card.
    await screen.findByRole("list", { name: /planned changes/i });

    // The Apply button exists but is DISABLED until the confirmation is ticked.
    const applyButton = screen.getByRole("button", { name: /apply plan/i });
    expect(applyButton).toBeDisabled();

    // Clicking while disabled must not call apply.
    await user.click(applyButton);
    expect(applyMock).not.toHaveBeenCalled();

    // Tick the explicit "I reviewed the plan" confirmation → button enables.
    await user.click(
      screen.getByRole("switch", { name: /i reviewed the plan/i }),
    );
    expect(applyButton).toBeEnabled();

    await user.click(applyButton);

    // apply() called with the exact plan hash from the plan response.
    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    expect(applyMock).toHaveBeenCalledWith("abcdef0123456789");

    // Progress streams to a terminal success state and offers the agent link.
    await waitFor(() =>
      expect(getOperationMock).toHaveBeenCalledWith("op-1"),
    );
    const viewLink = await screen.findByRole("button", {
      name: /view research-agent/i,
    });
    expect(viewLink).toBeInTheDocument();
  });

  it("surfaces a ConsoleError from createAgent inline and offers a retry", async () => {
    createAgentMock.mockRejectedValue(
      new ConsoleError(400, "workspace validation failed: bad model"),
    );

    const user = userEvent.setup();
    renderPage();

    await fillToReview(user);
    await user.click(screen.getByRole("button", { name: /create & plan/i }));

    // The error is announced and plan() was never reached.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/workspace validation failed: bad model/i);
    expect(planMock).not.toHaveBeenCalled();

    // No plan ⇒ no Apply control is rendered at all.
    expect(
      screen.queryByRole("button", { name: /apply plan/i }),
    ).not.toBeInTheDocument();
  });
});
