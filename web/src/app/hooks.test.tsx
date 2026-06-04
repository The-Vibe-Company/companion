/**
 * Tests for the polling hooks, with the API client mocked so no network is hit.
 *
 * The load-bearing behavior is `useOperation`: it must keep polling while an
 * operation is `running` and then STOP issuing requests the moment it observes a
 * terminal state (`succeeded`/`failed`). We drive virtual time with fake timers
 * and assert on the call count of the mocked `getOperation`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useOperation, usePolling } from "./hooks";
import type { OperationStatus } from "../api/types";

// Mock the client module the hooks import from.
vi.mock("../api/client", () => ({
  getOperation: vi.fn(),
  getStatus: vi.fn(),
}));
import { getOperation } from "../api/client";

const mockGetOperation = vi.mocked(getOperation);

function op(state: OperationStatus["state"]): OperationStatus {
  return { id: "op1", state, changed_resources: [] };
}

/** Renders useOperation and surfaces its state for assertions. */
function OperationProbe({ id }: { id: string | null }) {
  const { data, loading } = useOperation(id, 1000);
  return (
    <div>
      <span data-testid="state">{data?.state ?? "none"}</span>
      <span data-testid="loading">{String(loading)}</span>
    </div>
  );
}

describe("useOperation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetOperation.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("stops polling once the operation reaches a terminal state", async () => {
    // running, running, then succeeded — after which polling must cease.
    mockGetOperation
      .mockResolvedValueOnce(op("running"))
      .mockResolvedValueOnce(op("running"))
      .mockResolvedValueOnce(op("succeeded"))
      .mockResolvedValue(op("succeeded"));

    render(<OperationProbe id="op1" />);

    // Initial immediate tick.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetOperation).toHaveBeenCalledTimes(1);

    // Two interval ticks reach the terminal "succeeded".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockGetOperation).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("state").textContent).toBe("succeeded");

    // Advancing further must NOT issue more requests: the timer was cleared.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockGetOperation).toHaveBeenCalledTimes(3);
  });

  it("does not poll when id is null", async () => {
    render(<OperationProbe id={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockGetOperation).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("none");
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("stops immediately when the first observed state is already failed", async () => {
    mockGetOperation.mockResolvedValue(op("failed"));
    render(<OperationProbe id="op1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetOperation).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // Terminal on the very first tick: no further polls.
    expect(mockGetOperation).toHaveBeenCalledTimes(1);
  });
});

/** Probe for the generic usePolling primitive. */
function PollingProbe({
  fn,
  interval,
}: {
  fn: () => Promise<string>;
  interval: number;
}) {
  const { data, error, loading } = usePolling(fn, interval, []);
  return (
    <div>
      <span data-testid="data">{data ?? "null"}</span>
      <span data-testid="error">{error?.message ?? "none"}</span>
      <span data-testid="loading">{String(loading)}</span>
    </div>
  );
}

describe("usePolling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes data on success and clears the loading flag (real timers)", async () => {
    const fn = vi.fn().mockResolvedValue("hello");
    render(<PollingProbe fn={fn} interval={0} />);
    await waitFor(() =>
      expect(screen.getByTestId("data").textContent).toBe("hello"),
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("none");
  });

  it("captures a thrown error into the error slot", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("kaboom"));
    render(<PollingProbe fn={fn} interval={0} />);
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe("kaboom"),
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("repeats on the interval while mounted", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue("tick");
    render(<PollingProbe fn={fn} interval={500} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
