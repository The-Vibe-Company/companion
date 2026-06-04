package console

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// waitForState polls the runner until the operation reaches the wanted terminal
// state or the deadline elapses. Convergence is driven by the runner goroutine
// writing the terminal state; the deadline is only a failure guard, not the
// synchronization mechanism, so this never depends on a fixed sleep duration for
// correctness.
func waitForState(t *testing.T, r *OperationRunner, id, want string) Operation {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		op, ok := r.Get(id)
		if !ok {
			t.Fatalf("operation %q not found", id)
		}
		if op.State == want {
			return op
		}
		if time.Now().After(deadline) {
			t.Fatalf("operation %q stuck in state %q, want %q", id, op.State, want)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRunnerStartConflict(t *testing.T) {
	t.Parallel()

	r := NewOperationRunner(nil)

	started := make(chan struct{})
	release := make(chan struct{})

	// First op signals when it is executing, then blocks until released so the
	// conflict window is deterministic rather than timing-dependent.
	id, ok := r.Start(func(ctx context.Context) ([]string, []byte, error) {
		close(started)
		<-release
		return []string{"fly_app.alpha", "tailscale_host.alpha"}, []byte(`{"changes":[]}`), nil
	})
	if !ok {
		t.Fatal("first Start returned ok=false, want true")
	}
	if id == "" {
		t.Fatal("first Start returned empty id")
	}

	<-started // op is now running and holds the active slot.

	if op, found := r.Get(id); !found || op.State != OpRunning {
		t.Fatalf("Get(%q) = (%+v, %v), want running", id, op, found)
	}

	// A second Start must be rejected while the first is active.
	if id2, ok2 := r.Start(func(ctx context.Context) ([]string, []byte, error) {
		t.Error("second run function must not execute while an apply is active")
		return nil, nil, nil
	}); ok2 || id2 != "" {
		t.Fatalf("second Start = (%q, %v), want (\"\", false)", id2, ok2)
	}

	close(release) // let the first op finish.

	op := waitForState(t, r, id, OpSucceeded)
	if got, want := op.Changed, []string{"fly_app.alpha", "tailscale_host.alpha"}; !equalStrings(got, want) {
		t.Fatalf("Changed = %v, want %v", got, want)
	}
	if string(op.PlanJSON) != `{"changes":[]}` {
		t.Fatalf("PlanJSON = %s, want %s", op.PlanJSON, `{"changes":[]}`)
	}
	jsonRoundTrips(t, op.PlanJSON)
	if op.FinishedAt.IsZero() {
		t.Fatal("FinishedAt is zero on a finished op")
	}
	if op.Error != "" {
		t.Fatalf("Error = %q, want empty", op.Error)
	}

	// Once the active op finished, the runner accepts a new apply.
	id3, ok3 := r.Start(func(ctx context.Context) ([]string, []byte, error) {
		return nil, nil, nil
	})
	if !ok3 || id3 == "" {
		t.Fatalf("Start after completion = (%q, %v), want a fresh id and true", id3, ok3)
	}
	if id3 == id {
		t.Fatalf("reused operation id %q", id3)
	}
	waitForState(t, r, id3, OpSucceeded)
}

func TestRunnerStartStates(t *testing.T) {
	t.Parallel()

	clock := func() time.Time { return testStamp }

	tests := []struct {
		name      string
		changed   []string
		planJSON  []byte
		runErr    error
		wantState string
		wantErr   string
	}{
		{
			name:      "success",
			changed:   []string{"fly_app.web"},
			planJSON:  []byte(`{"changes":[{"address":"fly_app.web"}]}`),
			wantState: OpSucceeded,
		},
		{
			name:      "failure",
			runErr:    errors.New("apply boom"),
			wantState: OpFailed,
			wantErr:   "apply boom",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := NewOperationRunner(clock)

			id, ok := r.Start(func(ctx context.Context) ([]string, []byte, error) {
				return tt.changed, tt.planJSON, tt.runErr
			})
			if !ok || id == "" {
				t.Fatalf("Start = (%q, %v), want id and true", id, ok)
			}

			op := waitForState(t, r, id, tt.wantState)
			if !op.StartedAt.Equal(testStamp) {
				t.Fatalf("StartedAt = %v, want %v (injected clock)", op.StartedAt, testStamp)
			}
			if !op.FinishedAt.Equal(testStamp) {
				t.Fatalf("FinishedAt = %v, want %v (injected clock)", op.FinishedAt, testStamp)
			}
			if op.Error != tt.wantErr {
				t.Fatalf("Error = %q, want %q", op.Error, tt.wantErr)
			}
			if !equalStrings(op.Changed, tt.changed) {
				t.Fatalf("Changed = %v, want %v", op.Changed, tt.changed)
			}
			if tt.planJSON != nil && string(op.PlanJSON) != string(tt.planJSON) {
				t.Fatalf("PlanJSON = %s, want %s", op.PlanJSON, tt.planJSON)
			}
			jsonRoundTrips(t, op.PlanJSON)
			// After a terminal state the active slot is free again.
			if next, ok := r.Start(func(ctx context.Context) ([]string, []byte, error) {
				return nil, nil, nil
			}); !ok || next == "" {
				t.Fatalf("Start after terminal state = (%q, %v), want a fresh apply", next, ok)
			}
		})
	}
}

// TestRunnerStartPanicRecovers proves a panicking run function does not wedge the
// runner: the op is marked failed and the active slot is released.
func TestRunnerStartPanicRecovers(t *testing.T) {
	t.Parallel()

	r := NewOperationRunner(nil)

	id, ok := r.Start(func(ctx context.Context) ([]string, []byte, error) {
		panic("kaboom")
	})
	if !ok {
		t.Fatal("Start returned ok=false, want true")
	}

	op := waitForState(t, r, id, OpFailed)
	if op.Error != "panic: kaboom" {
		t.Fatalf("Error = %q, want %q", op.Error, "panic: kaboom")
	}

	// The runner is usable again after a panic.
	id2, ok2 := r.Start(func(ctx context.Context) ([]string, []byte, error) {
		return nil, nil, nil
	})
	if !ok2 || id2 == "" {
		t.Fatalf("Start after panic = (%q, %v), want a fresh apply", id2, ok2)
	}
	waitForState(t, r, id2, OpSucceeded)
}

// TestRunnerGetUnknown documents the not-found path.
func TestRunnerGetUnknown(t *testing.T) {
	t.Parallel()

	r := NewOperationRunner(nil)
	if op, ok := r.Get("does-not-exist"); ok || op.ID != "" {
		t.Fatalf("Get(unknown) = (%+v, %v), want (zero, false)", op, ok)
	}
}

// TestRunnerCloseCancelsContext proves Close cancels the lifecycle context that
// in-flight run functions receive.
func TestRunnerCloseCancelsContext(t *testing.T) {
	t.Parallel()

	r := NewOperationRunner(nil)

	got := make(chan error, 1)
	release := make(chan struct{})
	id, ok := r.Start(func(ctx context.Context) ([]string, []byte, error) {
		<-release
		got <- ctx.Err()
		return nil, nil, ctx.Err()
	})
	if !ok {
		t.Fatal("Start returned ok=false, want true")
	}

	r.Close()
	close(release)

	select {
	case err := <-got:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("run ctx.Err() = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run function did not observe cancellation")
	}

	op := waitForState(t, r, id, OpFailed)
	if op.Error == "" {
		t.Fatal("Error is empty on a cancelled op, want context error")
	}
}

// equalStrings compares two string slices, treating nil and empty as equal so
// the success-with-no-changes case is not spuriously different from nil.
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// jsonRoundTrips guards that the recorded PlanJSON stays valid JSON the API can
// re-emit verbatim.
func jsonRoundTrips(t *testing.T, raw json.RawMessage) {
	t.Helper()
	if len(raw) == 0 {
		return
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("PlanJSON is not valid JSON: %v", err)
	}
}

// TestRunnerEvictsOldestOperations guards the bounded retention: after more than
// maxRetainedOps applies, the oldest operations are evicted while the newest stay
// retrievable, so a long-lived console does not grow ops without bound.
func TestRunnerEvictsOldestOperations(t *testing.T) {
	r := NewOperationRunner(nil)
	ids := make([]string, 0, maxRetainedOps+10)
	for i := 0; i < maxRetainedOps+10; i++ {
		id, ok := r.Start(func(ctx context.Context) ([]string, []byte, error) {
			return nil, nil, nil
		})
		if !ok {
			t.Fatalf("Start %d returned ok=false (runner wedged)", i)
		}
		// Wait for completion so active clears before the next Start.
		waitForState(t, r, id, OpSucceeded)
		ids = append(ids, id)
	}

	if _, ok := r.Get(ids[0]); ok {
		t.Fatalf("oldest operation should have been evicted")
	}
	if _, ok := r.Get(ids[len(ids)-1]); !ok {
		t.Fatalf("newest operation should be retained")
	}
}
