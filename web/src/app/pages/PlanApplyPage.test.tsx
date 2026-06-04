/**
 * PlanApplyPage tests.
 *
 * The whole point of this page is a safe, explicit two-stage mutate flow, so the
 * tests drive it the way an operator would and assert the load-bearing behavior:
 *
 *  - the apply history list renders (and shows its empty state when there is no
 *    history);
 *  - "Run plan" calls `plan()` and renders the diff + the plan hash;
 *  - "Apply" is GATED: disabled until the explicit confirmation toggle is ticked;
 *  - confirming + applying calls `apply()` with the EXACT plan hash, then renders
 *    live operation progress (changed resources) and refreshes the history;
 *  - a 409 from apply surfaces a distinct "plan is no longer current" prompt to
 *    re-run plan, not a generic failure.
 *
 * The network is mocked at the client boundary (`vi.mock('../../api/client')`),
 * so nothing here touches a live console server or provider. The page is hosted
 * in a MemoryRouter because it is normally rendered inside the router outlet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ConsoleError } from "../../api/client";
import type {
  ApplyHistoryEntry,
  ApplyResponse,
  OperationStatus,
  PlanOptions,
  PlanResponse,
} from "../../api/types";
import PlanApplyPage from "./PlanApplyPage";

// Mock the entire client module: the page imports plan/apply/listApplies from
// here, and OperationProgress/useOperation import getOperation from the same
// module, so this one mock covers the full flow. ConsoleError is preserved as
// the real class so `instanceof` checks in the page still work.
vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>(
    "../../api/client",
  );
  return {
    ...actual,
    plan: vi.fn(),
    apply: vi.fn(),
    listApplies: vi.fn(),
    getOperation: vi.fn(),
  };
});

// Import the mocked functions after registering the mock so the typed handles
// point at the vi.fn() instances.
import { apply, getOperation, listApplies, plan } from "../../api/client";

const mockPlan = vi.mocked(plan);
const mockApply = vi.mocked(apply);
const mockListApplies = vi.mocked(listApplies);
const mockGetOperation = vi.mocked(getOperation);

function planResponse(over: Partial<PlanResponse> = {}): PlanResponse {
  return {
    hash: "abc123def456",
    text: "fly_app.research-agent will be created",
    changes: [
      {
        kind: "+",
        action: "create",
        address: "fly_app.research-agent",
        message: "create app",
        protected: false,
      },
    ],
    requires_protected_confirm: false,
    requires_destroy_data: false,
    ...over,
  };
}

function historyEntry(over: Partial<ApplyHistoryEntry> = {}): ApplyHistoryEntry {
  return {
    id: 7,
    started_at: "2026-06-04T10:00:00Z",
    finished_at: "2026-06-04T10:01:00Z",
    status: "succeeded",
    ...over,
  };
}

function operationStatus(over: Partial<OperationStatus> = {}): OperationStatus {
  return {
    id: "op-1",
    state: "succeeded",
    changed_resources: [],
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PlanApplyPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Sensible defaults; individual tests override as needed.
  mockListApplies.mockResolvedValue([]);
  mockPlan.mockResolvedValue(planResponse());
  mockApply.mockResolvedValue({ operation_id: "op-1" } satisfies ApplyResponse);
  // Default: an apply operation that is already terminal on first poll, so the
  // first (immediate) tick of useOperation reaches a terminal state without
  // needing timers.
  mockGetOperation.mockResolvedValue(
    operationStatus({ changed_resources: ["fly_app.research-agent"] }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PlanApplyPage", () => {
  it("shows the empty plan state and an empty apply history on first load", async () => {
    renderPage();

    // No plan computed yet.
    expect(screen.getByText(/no plan yet/i)).toBeInTheDocument();
    // History resolved to [] -> its empty state, not an error.
    expect(await screen.findByText(/no applies yet/i)).toBeInTheDocument();
    // The apply Card only appears once there is a plan.
    expect(
      screen.queryByRole("button", { name: /apply plan/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the apply history newest-first with status", async () => {
    mockListApplies.mockResolvedValue([
      historyEntry({ id: 9, status: "succeeded" }),
      historyEntry({ id: 8, status: "failed" }),
    ]);
    renderPage();

    const list = await screen.findByRole("list", { name: /recent applies/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("#9")).toBeInTheDocument();
    expect(within(rows[0]).getByText("succeeded")).toBeInTheDocument();
    expect(within(rows[1]).getByText("#8")).toBeInTheDocument();
    expect(within(rows[1]).getByText("failed")).toBeInTheDocument();
  });

  it("surfaces an apply-history load error with a retry", async () => {
    mockListApplies.mockRejectedValueOnce(new Error("boom"));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText(/could not load apply history/i),
    ).toBeInTheDocument();

    // Retrying re-calls listApplies; the second call resolves and the list shows.
    mockListApplies.mockResolvedValue([historyEntry({ id: 3 })]);
    await userEvent.click(within(alert).getByRole("button", { name: /retry/i }));
    expect(
      await screen.findByRole("list", { name: /recent applies/i }),
    ).toBeInTheDocument();
  });

  it("runs a plan and renders the diff and the plan hash", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /run plan/i }));

    expect(mockPlan).toHaveBeenCalledTimes(1);
    // The diff renders the change address...
    expect(
      await screen.findByText("fly_app.research-agent"),
    ).toBeInTheDocument();
    // ...and the plan hash is shown so the apply guard is visible.
    expect(screen.getByTestId("plan-hash")).toHaveTextContent("abc123def456");
  });

  it("surfaces a plan failure with a retry and no diff", async () => {
    mockPlan.mockRejectedValueOnce(new ConsoleError(502, "provider unavailable"));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^run plan$/i }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/plan failed/i)).toBeInTheDocument();
    expect(within(alert).getByText(/provider unavailable/i)).toBeInTheDocument();
    // The apply card never appeared because there is no plan.
    expect(
      screen.queryByRole("button", { name: /apply plan/i }),
    ).not.toBeInTheDocument();
  });

  it("gates apply behind the confirmation toggle", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /run plan/i }));
    await screen.findByText("fly_app.research-agent");

    const applyButton = screen.getByRole("button", { name: /apply plan/i });
    // Disabled until the operator explicitly confirms.
    expect(applyButton).toBeDisabled();
    expect(mockApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole("switch"));
    expect(applyButton).toBeEnabled();
  });

  it("applies with the exact plan hash and renders live operation progress", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /run plan/i }));
    await screen.findByText("fly_app.research-agent");

    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: /apply plan/i }));

    // apply() is called with the hash from the plan response — the staleness guard.
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith("abc123def456");

    // OperationProgress polls getOperation and renders the terminal state plus
    // the changed resource address.
    expect(await screen.findByText("succeeded")).toBeInTheDocument();
    expect(
      await screen.findByText("fly_app.research-agent", {
        selector: "li",
      }),
    ).toBeInTheDocument();
    expect(mockGetOperation).toHaveBeenCalledWith("op-1");

    // Completing an apply refreshes the history (listApplies called again:
    // once on mount, once after completion).
    await waitFor(() =>
      expect(mockListApplies.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it("shows a distinct stale-plan prompt on a 409 apply conflict", async () => {
    mockApply.mockRejectedValueOnce(
      new ConsoleError(409, "stale plan: re-run plan and apply the current hash"),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /run plan/i }));
    await screen.findByText("fly_app.research-agent");

    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: /apply plan/i }));

    // The 409 is treated as "plan went stale", not a generic failure, and the
    // recovery action re-runs plan.
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText(/no longer current/i),
    ).toBeInTheDocument();
    expect(within(alert).getByText(/re-run plan/i)).toBeInTheDocument();

    // No operation progress is shown because apply never returned an id.
    expect(mockGetOperation).not.toHaveBeenCalled();

    // The retry button on the conflict banner re-runs plan.
    mockPlan.mockClear();
    await user.click(within(alert).getByRole("button", { name: /retry/i }));
    expect(mockPlan).toHaveBeenCalledTimes(1);
  });

  it("re-running plan resets the confirmation gate", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /run plan/i }));
    await screen.findByText("fly_app.research-agent");

    // Confirm, then re-run plan: the toggle must reset so apply is re-gated.
    await user.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toBeChecked();

    await user.click(screen.getByRole("button", { name: /re-run plan/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /apply plan/i })).toBeDisabled(),
    );
    expect(screen.getByRole("switch")).not.toBeChecked();
  });

  it("gates a protected destroy behind the destroy confirmations, then applies", async () => {
    // Model the backend: with no destroy flag the protected resources are
    // blocked; once allowProtectedDestroy is set they become real deletes.
    mockPlan.mockImplementation(async (opts?: PlanOptions) => {
      const allow = opts?.allowProtectedDestroy ?? false;
      return planResponse({
        hash: allow ? "destroy-hash" : "blocked-hash",
        text: "destroy example-agent",
        changes: [
          {
            kind: allow ? "-" : "!",
            action: allow ? "delete" : "blocked",
            address: "fly_app.example-agent",
            message: "",
            protected: true,
          },
          {
            kind: allow ? "-" : "!",
            action: allow ? "delete" : "blocked",
            address: "fly_volume.agent_data.example-agent",
            message: "",
            protected: true,
          },
        ],
        requires_protected_confirm: true,
        requires_destroy_data: true,
      });
    });

    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /run plan/i }));
    await screen.findByText("fly_app.example-agent");

    const applyButton = () =>
      screen.getByRole("button", { name: /apply plan/i });

    // The danger zone appears (its protected-destroy switch) and apply is blocked.
    expect(
      screen.getByRole("switch", { name: /destroy protected resources/i }),
    ).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();

    // "I understand" alone is not enough while protected resources are blocked.
    await user.click(
      screen.getByRole("switch", { name: /applies changes to the live fleet/i }),
    );
    expect(applyButton()).toBeDisabled();

    // Allow protected destroy: re-plans to real deletes, but the volume still
    // needs the persistent-data confirmation, so apply stays disabled.
    await user.click(
      screen.getByRole("switch", { name: /destroy protected resources/i }),
    );
    await waitFor(() => expect(applyButton()).toBeDisabled());

    // Allow persistent-data destruction, then re-confirm (re-planning reset the
    // gate) — every confirmation is now satisfied.
    await user.click(screen.getByRole("switch", { name: /persistent data/i }));
    await user.click(
      screen.getByRole("switch", { name: /applies changes to the live fleet/i }),
    );

    await waitFor(() => expect(applyButton()).toBeEnabled());
    await user.click(applyButton());

    // Apply uses the confirmed-plan hash — the destroy plan the operator saw.
    expect(mockApply).toHaveBeenCalledWith("destroy-hash");
  });
});
