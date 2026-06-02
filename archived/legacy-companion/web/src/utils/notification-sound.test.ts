// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Tests for the notification-sound module which uses the Web Audio API
 * to play a two-tone chime (E5 -> G5). Since jsdom does not provide
 * AudioContext, we mock it globally and use vi.resetModules() + dynamic
 * import() so the module-level `audioContext` singleton is reset between tests.
 */

/** Creates a mock AudioContext with spied oscillator and gain node factories. */
function createMockAudioContext() {
  const mockGainNode = {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
  const mockOscillator = {
    type: "",
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return {
    state: "running" as string,
    currentTime: 0,
    destination: {},
    resume: vi.fn(),
    // Return fresh copies each time so calls to the two oscillators are independent
    createOscillator: vi.fn(() => ({ ...mockOscillator })),
    createGain: vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    })),
  };
}

let mockCtx: ReturnType<typeof createMockAudioContext>;

beforeEach(() => {
  // Reset modules so the module-level `audioContext` variable starts as null
  vi.resetModules();
  mockCtx = createMockAudioContext();
  // Must use `function` (not arrow) so the mock is valid as a constructor with `new`
  globalThis.AudioContext = vi.fn(function () {
    return mockCtx;
  }) as unknown as typeof AudioContext;
});

describe("playNotificationSound", () => {
  it("creates an AudioContext and plays two oscillator tones", async () => {
    // Validates that a single call creates the context, sets up two oscillators
    // with correct frequencies (E5=659.25 Hz, G5=783.99 Hz), connects them
    // through gain nodes to the destination, and starts/stops them.
    const { playNotificationSound } = await import("./notification-sound.js");

    playNotificationSound();

    // AudioContext should have been constructed once
    expect(globalThis.AudioContext).toHaveBeenCalledTimes(1);

    // Two oscillators and two gain nodes should be created
    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);
    expect(mockCtx.createGain).toHaveBeenCalledTimes(2);

    // First oscillator: E5 (659.25 Hz)
    const osc1 = mockCtx.createOscillator.mock.results[0].value;
    expect(osc1.type).toBe("sine");
    expect(osc1.frequency.setValueAtTime).toHaveBeenCalledWith(659.25, 0);
    expect(osc1.start).toHaveBeenCalledWith(0);
    expect(osc1.stop).toHaveBeenCalledWith(0.3);

    // First gain node: ramps down from 0.3
    const gain1 = mockCtx.createGain.mock.results[0].value;
    expect(gain1.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 0);
    expect(gain1.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, 0.3);
    expect(osc1.connect).toHaveBeenCalledWith(gain1);
    expect(gain1.connect).toHaveBeenCalledWith(mockCtx.destination);

    // Second oscillator: G5 (783.99 Hz)
    const osc2 = mockCtx.createOscillator.mock.results[1].value;
    expect(osc2.type).toBe("sine");
    expect(osc2.frequency.setValueAtTime).toHaveBeenCalledWith(783.99, 0.15);
    expect(osc2.start).toHaveBeenCalledWith(0.15);
    expect(osc2.stop).toHaveBeenCalledWith(0.5);

    // Second gain node: fades in at 0.15 then ramps down
    const gain2 = mockCtx.createGain.mock.results[1].value;
    expect(gain2.gain.setValueAtTime).toHaveBeenCalledWith(0.001, 0);
    expect(gain2.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 0.15);
    expect(gain2.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, 0.5);
    expect(osc2.connect).toHaveBeenCalledWith(gain2);
    expect(gain2.connect).toHaveBeenCalledWith(mockCtx.destination);
  });

  it("reuses the existing AudioContext on subsequent calls", async () => {
    // The module caches AudioContext in a module-level variable. Calling
    // playNotificationSound twice should only construct one AudioContext.
    const { playNotificationSound } = await import("./notification-sound.js");

    playNotificationSound();
    playNotificationSound();

    // Constructor should only be called once; the cached instance is reused
    expect(globalThis.AudioContext).toHaveBeenCalledTimes(1);
    // But oscillators/gains are created fresh each call (2 per call = 4 total)
    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(4);
    expect(mockCtx.createGain).toHaveBeenCalledTimes(4);
  });

  it("resumes a suspended AudioContext before playing", async () => {
    // When the browser suspends the AudioContext (common before user gesture),
    // the module should call resume() before creating oscillators.
    mockCtx.state = "suspended";
    const { playNotificationSound } = await import("./notification-sound.js");

    playNotificationSound();

    expect(mockCtx.resume).toHaveBeenCalledTimes(1);
  });

  it("does not call resume when AudioContext is already running", async () => {
    // When state is "running", resume() should not be called unnecessarily.
    mockCtx.state = "running";
    const { playNotificationSound } = await import("./notification-sound.js");

    playNotificationSound();

    expect(mockCtx.resume).not.toHaveBeenCalled();
  });

  it("silently catches errors if AudioContext constructor throws", async () => {
    // If the Web Audio API is unavailable or throws (e.g. in restrictive
    // environments), the function should swallow the error without propagating.
    globalThis.AudioContext = vi.fn(function () {
      throw new Error("AudioContext not supported");
    }) as unknown as typeof AudioContext;

    const { playNotificationSound } = await import("./notification-sound.js");

    // Should not throw
    expect(() => playNotificationSound()).not.toThrow();
  });

  it("silently catches errors if createOscillator throws", async () => {
    // Even if the context is created successfully but a method on it throws,
    // the error should be caught and silenced.
    mockCtx.createOscillator = vi.fn(() => {
      throw new Error("createOscillator failed");
    });
    const { playNotificationSound } = await import("./notification-sound.js");

    expect(() => playNotificationSound()).not.toThrow();
  });
});
