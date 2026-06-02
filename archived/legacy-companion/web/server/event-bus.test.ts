import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "./event-bus.js";

// Minimal event map for testing
interface TestEvents {
  "test:foo": { value: number };
  "test:bar": { name: string };
}

describe("EventBus", () => {
  let bus: EventBus<TestEvents>;

  beforeEach(() => {
    bus = new EventBus<TestEvents>();
  });

  // ── on / emit ──────────────────────────────────────────────────────

  it("calls handler when event is emitted", () => {
    const handler = vi.fn();
    bus.on("test:foo", handler);
    bus.emit("test:foo", { value: 42 });
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it("supports multiple handlers for the same event", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("test:foo", h1);
    bus.on("test:foo", h2);
    bus.emit("test:foo", { value: 1 });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("does not call handlers for different events", () => {
    const handler = vi.fn();
    bus.on("test:foo", handler);
    bus.emit("test:bar", { name: "x" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("emit with no handlers is a no-op", () => {
    // Should not throw
    expect(() => bus.emit("test:foo", { value: 0 })).not.toThrow();
  });

  // ── unsubscribe ────────────────────────────────────────────────────

  it("unsubscribe function returned by on() removes handler", () => {
    const handler = vi.fn();
    const unsub = bus.on("test:foo", handler);
    unsub();
    bus.emit("test:foo", { value: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── off ────────────────────────────────────────────────────────────

  it("off() removes a specific handler", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("test:foo", h1);
    bus.on("test:foo", h2);
    bus.off("test:foo", h1);
    bus.emit("test:foo", { value: 1 });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  // ── once ───────────────────────────────────────────────────────────

  it("once() handler is called on first emit only", () => {
    const handler = vi.fn();
    bus.once("test:foo", handler);
    bus.emit("test:foo", { value: 1 });
    bus.emit("test:foo", { value: 2 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ value: 1 });
  });

  it("once() unsubscribe function removes handler before it fires", () => {
    const handler = vi.fn();
    const unsub = bus.once("test:foo", handler);
    unsub();
    bus.emit("test:foo", { value: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── error isolation ────────────────────────────────────────────────

  it("catches synchronous handler errors without affecting other handlers", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const badHandler = () => {
      throw new Error("boom");
    };
    const goodHandler = vi.fn();

    bus.on("test:foo", badHandler);
    bus.on("test:foo", goodHandler);
    bus.emit("test:foo", { value: 1 });

    // Good handler still called despite bad handler throwing
    expect(goodHandler).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[event-bus] Handler error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("catches async handler errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const asyncHandler = async () => {
      throw new Error("async boom");
    };

    bus.on("test:foo", asyncHandler);
    bus.emit("test:foo", { value: 1 });

    // Wait for the microtask that catches the promise rejection
    await new Promise((r) => setTimeout(r, 10));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[event-bus] Async handler error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("catches once-handler errors without affecting other once-handlers", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const badHandler = () => {
      throw new Error("once boom");
    };
    const goodHandler = vi.fn();

    bus.once("test:foo", badHandler);
    bus.once("test:foo", goodHandler);
    bus.emit("test:foo", { value: 1 });

    expect(goodHandler).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[event-bus] Once-handler error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  // ── clear ──────────────────────────────────────────────────────────

  it("clear() removes all handlers", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("test:foo", h1);
    bus.once("test:bar", h2);
    bus.clear();
    bus.emit("test:foo", { value: 1 });
    bus.emit("test:bar", { name: "x" });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  // ── listenerCount ──────────────────────────────────────────────────

  it("listenerCount() returns correct count", () => {
    expect(bus.listenerCount("test:foo")).toBe(0);
    bus.on("test:foo", vi.fn());
    expect(bus.listenerCount("test:foo")).toBe(1);
    bus.once("test:foo", vi.fn());
    expect(bus.listenerCount("test:foo")).toBe(2);
  });

  it("listenerCount() decreases after unsubscribe", () => {
    const h = vi.fn();
    const unsub = bus.on("test:foo", h);
    expect(bus.listenerCount("test:foo")).toBe(1);
    unsub();
    expect(bus.listenerCount("test:foo")).toBe(0);
  });

  it("listenerCount() decreases after once handler fires", () => {
    bus.once("test:foo", vi.fn());
    expect(bus.listenerCount("test:foo")).toBe(1);
    bus.emit("test:foo", { value: 1 });
    expect(bus.listenerCount("test:foo")).toBe(0);
  });

  // ── mixed on + once ────────────────────────────────────────────────

  it("on and once handlers both fire, once removed after", () => {
    const persistent = vi.fn();
    const oneShot = vi.fn();
    bus.on("test:foo", persistent);
    bus.once("test:foo", oneShot);

    bus.emit("test:foo", { value: 1 });
    expect(persistent).toHaveBeenCalledOnce();
    expect(oneShot).toHaveBeenCalledOnce();

    bus.emit("test:foo", { value: 2 });
    expect(persistent).toHaveBeenCalledTimes(2);
    expect(oneShot).toHaveBeenCalledOnce(); // still only once
  });

  // ── snapshot safety ───────────────────────────────────────────────

  it("handlers added during emit are not called in the same dispatch", () => {
    // Verifies that emit() snapshots the handler set before iterating,
    // so a handler that subscribes a new handler during dispatch does not
    // cause the new handler to fire in the same emit cycle.
    const late = vi.fn();
    const adder = () => {
      bus.on("test:foo", late);
    };

    bus.on("test:foo", adder);
    bus.emit("test:foo", { value: 1 });
    // late was added during dispatch but should NOT have been called
    expect(late).not.toHaveBeenCalled();

    // On the next emit, late should fire
    bus.emit("test:foo", { value: 2 });
    expect(late).toHaveBeenCalledWith({ value: 2 });
  });

  it("handlers removed during emit still fire in the same dispatch", () => {
    // Verifies snapshot: unsubscribing a handler mid-dispatch does not
    // prevent it from running since the snapshot was taken before iteration.
    const h1 = vi.fn();
    const h2 = vi.fn();
    let unsub2: () => void;

    const remover = () => {
      unsub2();
    };

    bus.on("test:foo", remover);
    unsub2 = bus.on("test:foo", h2);
    bus.emit("test:foo", { value: 1 });
    // h2 was in the snapshot, so it still fires despite being removed mid-dispatch
    expect(h2).toHaveBeenCalledWith({ value: 1 });
  });
});
