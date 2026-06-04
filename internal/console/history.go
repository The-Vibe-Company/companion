package console

import (
	"context"
	"database/sql"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/state"
)

// History reads past apply records from the state store. It queries the SQLite
// applies table directly via the exported *sql.DB.
type History struct {
	store *state.Store
}

// NewHistory wraps a state store for read-only apply history queries.
func NewHistory(store *state.Store) *History {
	return &History{store: store}
}

// List returns up to limit most-recent apply records, newest first. A missing
// or empty applies table yields an empty slice rather than an error, and a NULL
// finished_at (an apply still in flight) maps to an empty FinishedAt string.
func (h *History) List(ctx context.Context, limit int) ([]ApplyHistoryEntry, error) {
	entries := []ApplyHistoryEntry{}
	if h == nil || h.store == nil || h.store.DB == nil {
		return entries, nil
	}
	if limit <= 0 {
		limit = 50
	}

	rows, err := h.store.DB.QueryContext(
		ctx,
		`SELECT id, started_at, finished_at, status
		 FROM applies
		 ORDER BY id DESC
		 LIMIT ?`,
		limit,
	)
	if err != nil {
		if isMissingTable(err) {
			return entries, nil
		}
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			entry      ApplyHistoryEntry
			finishedAt sql.NullString
		)
		if err := rows.Scan(&entry.ID, &entry.StartedAt, &finishedAt, &entry.Status); err != nil {
			return nil, err
		}
		if finishedAt.Valid {
			entry.FinishedAt = finishedAt.String
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

// isMissingTable reports whether err is a SQLite "no such table" error, which we
// treat as an empty history rather than a hard failure.
func isMissingTable(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "no such table")
}
