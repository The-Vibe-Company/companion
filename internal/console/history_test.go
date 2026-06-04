package console

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/The-Vibe-Company/companion/internal/state"
)

// openTestStore opens a fresh SQLite state store backed by a per-test temp dir.
func openTestStore(t *testing.T) *state.Store {
	t.Helper()
	store, err := state.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatalf("open state: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func TestHistoryListReturnsAppliesNewestFirst(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

	// First apply: finished successfully.
	firstID, err := store.StartApply(ctx, map[string]any{"changes": 1})
	if err != nil {
		t.Fatalf("start first apply: %v", err)
	}
	if err := store.FinishApply(ctx, firstID, "succeeded"); err != nil {
		t.Fatalf("finish first apply: %v", err)
	}

	// Second apply: finished with failure.
	secondID, err := store.StartApply(ctx, map[string]any{"changes": 2})
	if err != nil {
		t.Fatalf("start second apply: %v", err)
	}
	if err := store.FinishApply(ctx, secondID, "failed"); err != nil {
		t.Fatalf("finish second apply: %v", err)
	}

	// Third apply: still running (finished_at is NULL).
	thirdID, err := store.StartApply(ctx, map[string]any{"changes": 3})
	if err != nil {
		t.Fatalf("start third apply: %v", err)
	}

	entries, err := NewHistory(store).List(ctx, 10)
	if err != nil {
		t.Fatalf("list history: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected three entries, got %d: %#v", len(entries), entries)
	}

	// Newest first: third, second, first.
	wantIDs := []int64{thirdID, secondID, firstID}
	wantStatuses := []string{"running", "failed", "succeeded"}
	for i, entry := range entries {
		if entry.ID != wantIDs[i] {
			t.Fatalf("entry %d: expected id %d, got %d (%#v)", i, wantIDs[i], entry.ID, entries)
		}
		if entry.Status != wantStatuses[i] {
			t.Fatalf("entry %d: expected status %q, got %q", i, wantStatuses[i], entry.Status)
		}
		if entry.StartedAt == "" {
			t.Fatalf("entry %d: expected non-empty started_at", i)
		}
	}

	// The two finished applies expose a finished_at; the running one does not.
	if entries[0].FinishedAt != "" {
		t.Fatalf("running apply should have empty finished_at, got %q", entries[0].FinishedAt)
	}
	if entries[1].FinishedAt == "" || entries[2].FinishedAt == "" {
		t.Fatalf("finished applies should expose finished_at, got %#v", entries)
	}
}

func TestHistoryListEmptyStore(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

	entries, err := NewHistory(store).List(ctx, 10)
	if err != nil {
		t.Fatalf("list empty history: %v", err)
	}
	if entries == nil {
		t.Fatalf("expected non-nil empty slice, got nil")
	}
	if len(entries) != 0 {
		t.Fatalf("expected empty history, got %#v", entries)
	}
}

func TestHistoryListRespectsLimit(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

	var ids []int64
	for i := 0; i < 3; i++ {
		id, err := store.StartApply(ctx, map[string]any{"n": i})
		if err != nil {
			t.Fatalf("start apply %d: %v", i, err)
		}
		if err := store.FinishApply(ctx, id, "succeeded"); err != nil {
			t.Fatalf("finish apply %d: %v", i, err)
		}
		ids = append(ids, id)
	}

	entries, err := NewHistory(store).List(ctx, 2)
	if err != nil {
		t.Fatalf("list history with limit: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected limit of two entries, got %d", len(entries))
	}
	// Most-recent two, newest first.
	if entries[0].ID != ids[2] || entries[1].ID != ids[1] {
		t.Fatalf("expected newest two ids %d,%d, got %d,%d", ids[2], ids[1], entries[0].ID, entries[1].ID)
	}
}

func TestHistoryListMissingTableIsEmpty(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

	if _, err := store.DB.ExecContext(ctx, `DROP TABLE applies`); err != nil {
		t.Fatalf("drop applies table: %v", err)
	}

	entries, err := NewHistory(store).List(ctx, 10)
	if err != nil {
		t.Fatalf("missing applies table should not error: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected empty history for missing table, got %#v", entries)
	}
}
