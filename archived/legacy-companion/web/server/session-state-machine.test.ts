import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SessionStateMachine,
  VALID_TRANSITIONS,
  type SessionPhase,
  type SessionTransitionEvent,
} from "./session-state-machine.js";

const ALL_PHASES: SessionPhase[] = [
  "starting",
  "initializing",
  "ready",
  "streaming",
  "awaiting_permission",
  "compacting",
  "reconnecting",
  "terminated",
];

describe("SessionStateMachine", () => {
  let sm: SessionStateMachine;

  beforeEach(() => {
    sm = new SessionStateMachine("test-session");
  });

  // ── Constructor ────────────────────────────────────────────────────

  describe("constructor", () => {
    it("defaults to 'starting' phase", () => {
      // The default initial phase should be "starting" when no second argument is passed.
      const machine = new SessionStateMachine("s1");
      expect(machine.phase).toBe("starting");
      expect(machine.sessionId).toBe("s1");
    });

    it("accepts a custom initial phase", () => {
      // When a second argument is provided, the machine should start in that phase.
      const machine = new SessionStateMachine("s2", "ready");
      expect(machine.phase).toBe("ready");
    });

    it("stores the sessionId", () => {
      const machine = new SessionStateMachine("my-session-id");
      expect(machine.sessionId).toBe("my-session-id");
    });
  });

  // ── Valid transitions ──────────────────────────────────────────────

  describe("valid transitions", () => {
    // Helper that creates a fresh machine in the given phase and asserts
    // that transitioning to `to` succeeds and updates the phase.
    function expectValidTransition(
      from: SessionPhase,
      to: SessionPhase,
    ): void {
      const machine = new SessionStateMachine("t", from);
      const result = machine.transition(to, `${from}->${to}`);
      expect(result).toBe(true);
      expect(machine.phase).toBe(to);
    }

    // starting -> initializing, streaming, reconnecting, terminated
    it("starting -> initializing", () =>
      expectValidTransition("starting", "initializing"));
    it("starting -> streaming", () =>
      expectValidTransition("starting", "streaming"));
    it("starting -> reconnecting", () =>
      expectValidTransition("starting", "reconnecting"));
    it("starting -> terminated", () =>
      expectValidTransition("starting", "terminated"));

    // initializing -> ready, streaming, reconnecting, terminated
    it("initializing -> ready", () =>
      expectValidTransition("initializing", "ready"));
    it("initializing -> streaming", () =>
      expectValidTransition("initializing", "streaming"));
    it("initializing -> reconnecting", () =>
      expectValidTransition("initializing", "reconnecting"));
    it("initializing -> terminated", () =>
      expectValidTransition("initializing", "terminated"));

    // ready -> streaming, compacting, reconnecting, terminated
    it("ready -> streaming", () =>
      expectValidTransition("ready", "streaming"));
    it("ready -> compacting", () =>
      expectValidTransition("ready", "compacting"));
    it("ready -> reconnecting", () =>
      expectValidTransition("ready", "reconnecting"));
    it("ready -> terminated", () =>
      expectValidTransition("ready", "terminated"));

    // streaming -> ready, initializing, awaiting_permission, compacting, reconnecting, terminated
    it("streaming -> ready", () =>
      expectValidTransition("streaming", "ready"));
    it("streaming -> initializing", () =>
      expectValidTransition("streaming", "initializing"));
    it("streaming -> awaiting_permission", () =>
      expectValidTransition("streaming", "awaiting_permission"));
    it("streaming -> compacting", () =>
      expectValidTransition("streaming", "compacting"));
    it("streaming -> reconnecting", () =>
      expectValidTransition("streaming", "reconnecting"));
    it("streaming -> terminated", () =>
      expectValidTransition("streaming", "terminated"));

    // awaiting_permission -> streaming, ready, reconnecting, terminated
    it("awaiting_permission -> streaming", () =>
      expectValidTransition("awaiting_permission", "streaming"));
    it("awaiting_permission -> ready", () =>
      expectValidTransition("awaiting_permission", "ready"));
    it("awaiting_permission -> reconnecting", () =>
      expectValidTransition("awaiting_permission", "reconnecting"));
    it("awaiting_permission -> terminated", () =>
      expectValidTransition("awaiting_permission", "terminated"));

    // compacting -> ready, streaming, reconnecting, terminated
    it("compacting -> ready", () =>
      expectValidTransition("compacting", "ready"));
    it("compacting -> streaming", () =>
      expectValidTransition("compacting", "streaming"));
    it("compacting -> reconnecting", () =>
      expectValidTransition("compacting", "reconnecting"));
    it("compacting -> terminated", () =>
      expectValidTransition("compacting", "terminated"));

    // reconnecting -> initializing, starting, ready, streaming, terminated
    it("reconnecting -> initializing", () =>
      expectValidTransition("reconnecting", "initializing"));
    it("reconnecting -> starting", () =>
      expectValidTransition("reconnecting", "starting"));
    it("reconnecting -> ready", () =>
      expectValidTransition("reconnecting", "ready"));
    it("reconnecting -> streaming", () =>
      expectValidTransition("reconnecting", "streaming"));
    it("reconnecting -> terminated", () =>
      expectValidTransition("reconnecting", "terminated"));

    // terminated -> starting
    it("terminated -> starting", () =>
      expectValidTransition("terminated", "starting"));
  });

  // ── Blocked transitions ────────────────────────────────────────────

  describe("blocked transitions", () => {
    // Helper that creates a fresh machine in the given phase and asserts
    // that transitioning to `to` fails (returns false) and does NOT change the phase.
    function expectBlockedTransition(
      from: SessionPhase,
      to: SessionPhase,
    ): void {
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const machine = new SessionStateMachine("t", from);
      const result = machine.transition(to, `blocked-${from}->${to}`);
      expect(result).toBe(false);
      expect(machine.phase).toBe(from);
      // Structured logger outputs the transition details; verify they appear
      expect(warnSpy).toHaveBeenCalled();
      const warnOutput = warnSpy.mock.calls[0][0] as string;
      expect(warnOutput).toContain(from);
      expect(warnOutput).toContain(to);
      warnSpy.mockRestore();
    }

    it("starting -> ready is blocked", () =>
      expectBlockedTransition("starting", "ready"));
    it("terminated -> ready is blocked", () =>
      expectBlockedTransition("terminated", "ready"));
    it("terminated -> streaming is blocked", () =>
      expectBlockedTransition("terminated", "streaming"));
    // reconnecting -> ready and reconnecting -> streaming are now valid
    // transitions (needed for Codex adapter WS reconnect recovery).
    it("ready -> initializing is blocked", () =>
      expectBlockedTransition("ready", "initializing"));
    it("awaiting_permission -> compacting is blocked", () =>
      expectBlockedTransition("awaiting_permission", "compacting"));
  });

  // ── Same-state transition ──────────────────────────────────────────

  describe("same-state transition", () => {
    it("returns true without calling listeners", () => {
      // A transition to the same phase should be a no-op: return true,
      // keep the same phase, and NOT notify any listeners.
      const listener = vi.fn();
      sm.onTransition(listener);
      const result = sm.transition("starting", "self-transition");
      expect(result).toBe(true);
      expect(sm.phase).toBe("starting");
      expect(listener).not.toHaveBeenCalled();
    });

    it("works for every phase", () => {
      // Verify same-state transitions are no-ops for all phases.
      for (const phase of ALL_PHASES) {
        const machine = new SessionStateMachine("t", phase);
        const listener = vi.fn();
        machine.onTransition(listener);
        expect(machine.transition(phase, "self")).toBe(true);
        expect(machine.phase).toBe(phase);
        expect(listener).not.toHaveBeenCalled();
      }
    });
  });

  // ── Guard methods ──────────────────────────────────────────────────

  describe("guard methods", () => {
    describe("canAcceptUserMessage()", () => {
      it("returns true only in 'ready'", () => {
        // canAcceptUserMessage should be true exclusively when the session is idle ("ready").
        for (const phase of ALL_PHASES) {
          const machine = new SessionStateMachine("t", phase);
          if (phase === "ready") {
            expect(machine.canAcceptUserMessage()).toBe(true);
          } else {
            expect(machine.canAcceptUserMessage()).toBe(false);
          }
        }
      });
    });

    describe("canRespondToPermission()", () => {
      it("returns true only in 'awaiting_permission'", () => {
        // canRespondToPermission should be true exclusively during a pending permission request.
        for (const phase of ALL_PHASES) {
          const machine = new SessionStateMachine("t", phase);
          if (phase === "awaiting_permission") {
            expect(machine.canRespondToPermission()).toBe(true);
          } else {
            expect(machine.canRespondToPermission()).toBe(false);
          }
        }
      });
    });

    describe("canSendToCLI()", () => {
      it("returns false for terminated, reconnecting, starting", () => {
        // The CLI socket is unreachable in these phases.
        const unreachable: SessionPhase[] = [
          "terminated",
          "reconnecting",
          "starting",
        ];
        for (const phase of unreachable) {
          const machine = new SessionStateMachine("t", phase);
          expect(machine.canSendToCLI()).toBe(false);
        }
      });

      it("returns true for initializing, ready, streaming, awaiting_permission, compacting", () => {
        // The CLI socket is expected to be reachable in these phases.
        const reachable: SessionPhase[] = [
          "initializing",
          "ready",
          "streaming",
          "awaiting_permission",
          "compacting",
        ];
        for (const phase of reachable) {
          const machine = new SessionStateMachine("t", phase);
          expect(machine.canSendToCLI()).toBe(true);
        }
      });
    });

    describe("isActive()", () => {
      it("returns false only in 'terminated'", () => {
        // isActive is false exclusively when the session has terminated.
        for (const phase of ALL_PHASES) {
          const machine = new SessionStateMachine("t", phase);
          if (phase === "terminated") {
            expect(machine.isActive()).toBe(false);
          } else {
            expect(machine.isActive()).toBe(true);
          }
        }
      });
    });

    describe("isIdle()", () => {
      it("returns true only in 'ready'", () => {
        // isIdle is true exclusively when the session is idle ("ready").
        for (const phase of ALL_PHASES) {
          const machine = new SessionStateMachine("t", phase);
          if (phase === "ready") {
            expect(machine.isIdle()).toBe(true);
          } else {
            expect(machine.isIdle()).toBe(false);
          }
        }
      });
    });
  });

  // ── Listener tests ─────────────────────────────────────────────────

  describe("listeners", () => {
    it("listener is called with correct SessionTransitionEvent", () => {
      // When a valid transition occurs, the listener should receive an event
      // containing sessionId, from, to, trigger, and a numeric timestamp.
      const listener = vi.fn();
      sm.onTransition(listener);

      sm.transition("initializing", "cli-connected");

      expect(listener).toHaveBeenCalledOnce();
      const event: SessionTransitionEvent = listener.mock.calls[0][0];
      expect(event.sessionId).toBe("test-session");
      expect(event.from).toBe("starting");
      expect(event.to).toBe("initializing");
      expect(event.trigger).toBe("cli-connected");
      expect(typeof event.timestamp).toBe("number");
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("multiple listeners are all called", () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      const l3 = vi.fn();
      sm.onTransition(l1);
      sm.onTransition(l2);
      sm.onTransition(l3);

      sm.transition("initializing", "test");

      expect(l1).toHaveBeenCalledOnce();
      expect(l2).toHaveBeenCalledOnce();
      expect(l3).toHaveBeenCalledOnce();
    });

    it("unsubscribe removes the listener", () => {
      const listener = vi.fn();
      const unsub = sm.onTransition(listener);

      // Unsubscribe before any transition
      unsub();
      sm.transition("initializing", "test");

      expect(listener).not.toHaveBeenCalled();
    });

    it("unsubscribe only removes the specific listener", () => {
      // When one listener unsubscribes, other listeners should still fire.
      const l1 = vi.fn();
      const l2 = vi.fn();
      const unsub1 = sm.onTransition(l1);
      sm.onTransition(l2);

      unsub1();
      sm.transition("initializing", "test");

      expect(l1).not.toHaveBeenCalled();
      expect(l2).toHaveBeenCalledOnce();
    });

    it("listener error is caught and logged without breaking the transition", () => {
      // If a listener throws, the error should be caught, logged, and
      // subsequent listeners should still be called. The transition itself
      // should still succeed.
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const badListener = () => {
        throw new Error("listener boom");
      };
      const goodListener = vi.fn();

      sm.onTransition(badListener);
      sm.onTransition(goodListener);

      const result = sm.transition("initializing", "test");

      expect(result).toBe(true);
      expect(sm.phase).toBe("initializing");
      expect(goodListener).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[state-machine] Listener error"),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it("listeners are NOT called on a blocked transition", () => {
      // When a transition is invalid/blocked, no listeners should be notified.
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const listener = vi.fn();
      sm.onTransition(listener);

      // starting -> ready is blocked
      sm.transition("ready", "invalid");

      expect(listener).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("listeners are NOT called on a same-state transition", () => {
      // Same-state transitions are no-ops and should not notify listeners.
      const listener = vi.fn();
      sm.onTransition(listener);

      sm.transition("starting", "no-op");

      expect(listener).not.toHaveBeenCalled();
    });

    it("snapshot safety: listeners added during dispatch do not fire in the same cycle", () => {
      // Verifies that the listener array is snapshotted before iteration,
      // so a listener that adds another listener during dispatch does not
      // cause the new listener to fire in the same transition.
      const lateListener = vi.fn();
      const adder = () => {
        sm.onTransition(lateListener);
      };

      sm.onTransition(adder);
      sm.transition("initializing", "test");

      // lateListener was added during dispatch but should NOT have been called
      expect(lateListener).not.toHaveBeenCalled();
    });
  });

  // ── forceState ─────────────────────────────────────────────────────

  describe("forceState", () => {
    it("sets state without validation", () => {
      // forceState should allow setting to any phase, even if the transition
      // would normally be blocked (e.g. starting -> awaiting_permission).
      sm.forceState("awaiting_permission");
      expect(sm.phase).toBe("awaiting_permission");
    });

    it("does not call listeners", () => {
      const listener = vi.fn();
      sm.onTransition(listener);

      sm.forceState("ready");

      expect(sm.phase).toBe("ready");
      expect(listener).not.toHaveBeenCalled();
    });

    it("works for any target state", () => {
      // forceState should work for every defined phase, regardless of current state.
      for (const phase of ALL_PHASES) {
        sm.forceState(phase);
        expect(sm.phase).toBe(phase);
      }
    });

    it("allows normally-invalid state jumps", () => {
      // Verify that forceState bypasses the transition table entirely.
      // terminated -> streaming is not in VALID_TRANSITIONS but forceState should allow it.
      sm.forceState("terminated");
      expect(sm.phase).toBe("terminated");
      sm.forceState("streaming");
      expect(sm.phase).toBe("streaming");
    });
  });

  // ── Full lifecycle scenario ────────────────────────────────────────

  describe("full lifecycle scenario", () => {
    it("walks through a complete session lifecycle", () => {
      // Simulates a realistic session lifecycle:
      // starting -> initializing -> ready -> streaming -> awaiting_permission
      // -> streaming -> ready -> reconnecting -> initializing -> ready
      // -> terminated -> starting
      const events: SessionTransitionEvent[] = [];
      sm.onTransition((e) => events.push(e));

      // CLI connects
      expect(sm.transition("initializing", "cli-ws-connected")).toBe(true);
      expect(sm.phase).toBe("initializing");

      // system.init received
      expect(sm.transition("ready", "system-init")).toBe(true);
      expect(sm.phase).toBe("ready");
      expect(sm.canAcceptUserMessage()).toBe(true);
      expect(sm.isIdle()).toBe(true);

      // User sends message, streaming begins
      expect(sm.transition("streaming", "user-message")).toBe(true);
      expect(sm.phase).toBe("streaming");
      expect(sm.canAcceptUserMessage()).toBe(false);
      expect(sm.canSendToCLI()).toBe(true);

      // Tool call requires permission
      expect(
        sm.transition("awaiting_permission", "tool-control-request"),
      ).toBe(true);
      expect(sm.phase).toBe("awaiting_permission");
      expect(sm.canRespondToPermission()).toBe(true);

      // User approves, streaming resumes
      expect(sm.transition("streaming", "permission-granted")).toBe(true);
      expect(sm.phase).toBe("streaming");
      expect(sm.canRespondToPermission()).toBe(false);

      // Streaming completes
      expect(sm.transition("ready", "result-received")).toBe(true);
      expect(sm.phase).toBe("ready");
      expect(sm.isIdle()).toBe(true);

      // Network interruption
      expect(sm.transition("reconnecting", "ws-close")).toBe(true);
      expect(sm.phase).toBe("reconnecting");
      expect(sm.canSendToCLI()).toBe(false);
      expect(sm.isActive()).toBe(true);

      // CLI reconnects
      expect(sm.transition("initializing", "cli-ws-reconnected")).toBe(
        true,
      );
      expect(sm.phase).toBe("initializing");
      expect(sm.canSendToCLI()).toBe(true);

      // Re-initialized
      expect(sm.transition("ready", "system-init")).toBe(true);
      expect(sm.phase).toBe("ready");

      // Session terminated
      expect(sm.transition("terminated", "process-exit")).toBe(true);
      expect(sm.phase).toBe("terminated");
      expect(sm.isActive()).toBe(false);
      expect(sm.canSendToCLI()).toBe(false);

      // Restarted
      expect(sm.transition("starting", "relaunch")).toBe(true);
      expect(sm.phase).toBe("starting");
      expect(sm.isActive()).toBe(true);

      // Verify all transitions were recorded
      expect(events).toHaveLength(11);
      expect(events.map((e) => `${e.from}->${e.to}`)).toEqual([
        "starting->initializing",
        "initializing->ready",
        "ready->streaming",
        "streaming->awaiting_permission",
        "awaiting_permission->streaming",
        "streaming->ready",
        "ready->reconnecting",
        "reconnecting->initializing",
        "initializing->ready",
        "ready->terminated",
        "terminated->starting",
      ]);

      // All events should have the correct sessionId and valid timestamps
      for (const event of events) {
        expect(event.sessionId).toBe("test-session");
        expect(typeof event.timestamp).toBe("number");
        expect(event.timestamp).toBeGreaterThan(0);
      }
    });

    it("handles early user message: starting -> streaming -> initializing -> ready", () => {
      // When a user sends a message before the CLI connects, the session
      // transitions starting -> streaming. When the CLI later connects,
      // it goes streaming -> initializing, then proceeds normally.
      const earlyMsg = new SessionStateMachine("early-msg", "starting");
      const events: SessionTransitionEvent[] = [];
      earlyMsg.onTransition((e) => events.push(e));

      expect(earlyMsg.transition("streaming", "user_message")).toBe(true);
      expect(earlyMsg.transition("initializing", "cli_ws_open")).toBe(true);
      expect(earlyMsg.transition("ready", "system_init")).toBe(true);
      expect(earlyMsg.transition("streaming", "user_message")).toBe(true);

      expect(events.map((e) => `${e.from}->${e.to}`)).toEqual([
        "starting->streaming",
        "streaming->initializing",
        "initializing->ready",
        "ready->streaming",
      ]);
    });
  });

  // ── VALID_TRANSITIONS table completeness ───────────────────────────

  describe("VALID_TRANSITIONS table", () => {
    it("every phase has an entry in the transition table", () => {
      // All defined phases should have a row in the transition table,
      // ensuring no phase is silently missing from the map.
      for (const phase of ALL_PHASES) {
        expect(VALID_TRANSITIONS.has(phase)).toBe(true);
      }
    });

    it("all target phases in the table are valid SessionPhase values", () => {
      // Ensures no typos or invalid phases in the transition targets.
      for (const [, targets] of VALID_TRANSITIONS) {
        for (const target of targets) {
          expect(ALL_PHASES).toContain(target);
        }
      }
    });
  });
});
