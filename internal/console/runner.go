package console

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// Operation states.
const (
	OpPending   = "pending"
	OpRunning   = "running"
	OpSucceeded = "succeeded"
	OpFailed    = "failed"
)

// maxRetainedOps bounds how many operations the runner keeps for polling via Get.
// Applies are infrequent and only the most recent matter to the UI, so older
// operations are evicted to keep memory bounded on a long-lived console process.
const maxRetainedOps = 100

// OperationRunner serializes apply operations: at most one apply is active at a
// time. Start launches the supplied run function in a goroutine and tracks its
// Operation by id; callers poll Get for progress. The injected clock keeps
// timestamps deterministic in tests.
type OperationRunner struct {
	clock func() time.Time

	// ctx ties launched operations to the server lifecycle. When the runner is
	// closed (or the server stops) the context is cancelled and passed to the run
	// function so long applies can observe cancellation. It is not required to be
	// cancellable from the API in v1.
	ctx    context.Context
	cancel context.CancelFunc

	mu     sync.Mutex
	active bool
	ops    map[string]*Operation
	// order records id insertion order so the oldest operations can be evicted
	// once retention exceeds maxRetainedOps.
	order []string
}

// NewOperationRunner builds an OperationRunner. A nil clock defaults to
// time.Now.
func NewOperationRunner(clock func() time.Time) *OperationRunner {
	if clock == nil {
		clock = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &OperationRunner{
		clock:  clock,
		ctx:    ctx,
		cancel: cancel,
		ops:    map[string]*Operation{},
	}
}

// Close cancels the lifecycle context shared by in-flight operations. Already
// recorded operations remain retrievable via Get. It is safe to call multiple
// times.
func (r *OperationRunner) Close() {
	if r.cancel != nil {
		r.cancel()
	}
}

// Start attempts to begin a new apply. It returns ok=false when an apply is
// already active (the API maps that to 409 Conflict). On success it returns the
// new operation id and runs fn asynchronously, advancing the operation through
// running -> succeeded/failed. fn receives a context tied to the runner
// lifecycle and returns the changed resource addresses, the canonical plan JSON
// it applied, and any error.
func (r *OperationRunner) Start(fn func(ctx context.Context) (changed []string, planJSON []byte, err error)) (id string, ok bool) {
	r.mu.Lock()
	if r.active {
		r.mu.Unlock()
		return "", false
	}

	id, err := randomID()
	if err != nil {
		r.mu.Unlock()
		return "", false
	}

	op := &Operation{
		ID:        id,
		State:     OpRunning,
		StartedAt: r.clock(),
	}
	r.active = true
	r.ops[id] = op
	r.order = append(r.order, id)
	r.evictLocked()
	r.mu.Unlock()

	go r.run(id, fn)

	return id, true
}

// run executes fn and records the terminal state under the lock. It always
// clears the active flag so a failed or panicking op never wedges the runner.
func (r *OperationRunner) run(id string, fn func(ctx context.Context) (changed []string, planJSON []byte, err error)) {
	var (
		changed  []string
		planJSON []byte
		runErr   error
	)

	defer func() {
		r.mu.Lock()
		defer r.mu.Unlock()

		op := r.ops[id]
		op.FinishedAt = r.clock()
		op.Changed = changed
		if len(planJSON) > 0 {
			op.PlanJSON = append([]byte(nil), planJSON...)
		}
		if rec := recover(); rec != nil {
			op.State = OpFailed
			op.Error = panicError(rec)
		} else if runErr != nil {
			op.State = OpFailed
			op.Error = runErr.Error()
		} else {
			op.State = OpSucceeded
		}
		r.active = false
	}()

	changed, planJSON, runErr = fn(r.ctx)
}

// Get returns the tracked operation by id. Finished operations remain
// retrievable.
func (r *OperationRunner) Get(id string) (Operation, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	op, ok := r.ops[id]
	if !ok {
		return Operation{}, false
	}
	return *op, true
}

// evictLocked drops the oldest operations once retention exceeds maxRetainedOps.
// The just-appended id is the active operation, so eviction from the front never
// removes an in-flight one. The caller must hold r.mu.
func (r *OperationRunner) evictLocked() {
	for len(r.order) > maxRetainedOps {
		oldest := r.order[0]
		r.order = r.order[1:]
		delete(r.ops, oldest)
	}
}

// randomID returns a short hex operation id from crypto/rand.
func randomID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// panicError renders a recovered panic value as a string for the operation
// error field.
func panicError(rec any) string {
	return fmt.Sprintf("panic: %v", rec)
}
