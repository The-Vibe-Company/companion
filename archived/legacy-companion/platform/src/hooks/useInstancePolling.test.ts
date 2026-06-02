// @vitest-environment jsdom
/**
 * Tests for the useInstancePolling hook.
 *
 * Validates that the hook:
 * - Polls when transitional instances exist
 * - Stops polling when all instances are settled
 * - Handles empty instance lists
 * - Respects custom polling intervals
 * - Cleans up on unmount
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInstancePolling } from "./useInstancePolling";

describe("useInstancePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll when all instances are settled", () => {
    const loadInstances = vi.fn();
    const instances = [
      { machineStatus: "started" },
      { machineStatus: "stopped" },
      { machineStatus: "running" },
    ];

    const { result } = renderHook(() =>
      useInstancePolling(instances, loadInstances, 1000),
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(loadInstances).not.toHaveBeenCalled();
    expect(result.current.isPolling).toBe(false);
  });

  it("does not poll when instances array is empty", () => {
    const loadInstances = vi.fn();

    const { result } = renderHook(() =>
      useInstancePolling([], loadInstances, 1000),
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(loadInstances).not.toHaveBeenCalled();
    expect(result.current.isPolling).toBe(false);
  });

  it("starts polling when a transitional instance is present", () => {
    const loadInstances = vi.fn();
    const instances = [{ machineStatus: "provisioning" }];

    const { result } = renderHook(() =>
      useInstancePolling(instances, loadInstances, 1000),
    );

    expect(result.current.isPolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(loadInstances).toHaveBeenCalledTimes(1);
  });

  it("polls repeatedly at the configured interval", () => {
    const loadInstances = vi.fn();
    const instances = [{ machineStatus: "provisioning" }];

    renderHook(() => useInstancePolling(instances, loadInstances, 1000));

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(loadInstances).toHaveBeenCalledTimes(3);
  });

  it("stops polling when instances transition to settled", () => {
    const loadInstances = vi.fn();
    let instances = [{ machineStatus: "provisioning" }];

    const { rerender } = renderHook(() =>
      useInstancePolling(instances, loadInstances, 1000),
    );

    // Advance one tick to confirm polling started
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(loadInstances).toHaveBeenCalledTimes(1);

    // Transition to settled
    instances = [{ machineStatus: "started" }];
    rerender();

    // No more calls after settling
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(loadInstances).toHaveBeenCalledTimes(1);
  });

  it("cleans up interval on unmount", () => {
    const loadInstances = vi.fn();
    const instances = [{ machineStatus: "provisioning" }];

    const { unmount } = renderHook(() =>
      useInstancePolling(instances, loadInstances, 1000),
    );

    unmount();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(loadInstances).not.toHaveBeenCalled();
  });

  it("respects custom interval", () => {
    const loadInstances = vi.fn();
    const instances = [{ machineStatus: "provisioning" }];

    renderHook(() => useInstancePolling(instances, loadInstances, 500));

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(loadInstances).toHaveBeenCalledTimes(4);
  });

  it("polls when mixed settled and transitional instances exist", () => {
    const loadInstances = vi.fn();
    const instances = [
      { machineStatus: "started" },
      { machineStatus: "provisioning" },
    ];

    const { result } = renderHook(() =>
      useInstancePolling(instances, loadInstances, 1000),
    );

    expect(result.current.isPolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(loadInstances).toHaveBeenCalledTimes(1);
  });
});
