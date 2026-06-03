package state

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	DB *sql.DB
}

type Resource struct {
	Address          string
	Class            string
	ProviderRef      string
	ExternalID       string
	Status           string
	DesiredHash      string
	ObservedJSON     string
	Protected        bool
	LastTransitionAt time.Time
	LastError        string
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	store := &Store{DB: db}
	if err := store.EnsureSchema(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

func (s *Store) EnsureSchema(ctx context.Context) error {
	if old, err := s.hasOldResourceSchema(ctx); err != nil {
		return err
	} else if old {
		if _, err := s.DB.ExecContext(ctx, `DROP TABLE resources`); err != nil {
			return err
		}
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS resources (
			address TEXT PRIMARY KEY,
			class TEXT NOT NULL,
			provider_ref TEXT NOT NULL,
			external_id TEXT NOT NULL,
			status TEXT NOT NULL,
			desired_hash TEXT NOT NULL,
			observed_json TEXT NOT NULL,
			protected INTEGER NOT NULL,
			last_transition_at TEXT NOT NULL,
			last_error TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp TEXT NOT NULL,
			command TEXT NOT NULL,
			subject TEXT NOT NULL,
			level TEXT NOT NULL,
			message TEXT NOT NULL,
			attrs_json TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS applies (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			status TEXT NOT NULL,
			plan_json TEXT NOT NULL
		)`,
	}
	for _, statement := range statements {
		if _, err := s.DB.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) hasOldResourceSchema(ctx context.Context) (bool, error) {
	rows, err := s.DB.QueryContext(ctx, `PRAGMA table_info(resources)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var cid int
		var name string
		var typ string
		var notNull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return false, err
		}
		seen[name] = true
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	if len(seen) == 0 {
		return false, nil
	}
	return !seen["address"], nil
}

func (s *Store) UpsertResource(ctx context.Context, resource Resource) error {
	if resource.LastTransitionAt.IsZero() {
		resource.LastTransitionAt = time.Now().UTC()
	}
	if resource.Status == "" {
		resource.Status = "ready"
	}
	if resource.ObservedJSON == "" {
		resource.ObservedJSON = "{}"
	}
	_, err := s.DB.ExecContext(
		ctx,
		`INSERT INTO resources(address, class, provider_ref, external_id, status, desired_hash, observed_json, protected, last_transition_at, last_error)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(address)
		 DO UPDATE SET class=excluded.class, provider_ref=excluded.provider_ref, external_id=excluded.external_id,
		 status=excluded.status, desired_hash=excluded.desired_hash, observed_json=excluded.observed_json,
		 protected=excluded.protected, last_transition_at=excluded.last_transition_at, last_error=excluded.last_error`,
		resource.Address,
		resource.Class,
		resource.ProviderRef,
		resource.ExternalID,
		resource.Status,
		resource.DesiredHash,
		resource.ObservedJSON,
		boolInt(resource.Protected),
		resource.LastTransitionAt.Format(time.RFC3339),
		resource.LastError,
	)
	return err
}

func (s *Store) ImportResource(ctx context.Context, resource Resource) error {
	if resource.Status == "" {
		resource.Status = "ready"
	}
	return s.UpsertResource(ctx, resource)
}

func (s *Store) GetResource(ctx context.Context, address string) (Resource, bool, error) {
	row := s.DB.QueryRowContext(
		ctx,
		`SELECT address, class, provider_ref, external_id, status, desired_hash, observed_json, protected, last_transition_at, last_error
		 FROM resources WHERE address=?`,
		address,
	)
	resource, err := scanResource(row)
	if err == sql.ErrNoRows {
		return Resource{}, false, nil
	}
	if err != nil {
		return Resource{}, false, err
	}
	return resource, true, nil
}

func (s *Store) ListResources(ctx context.Context) ([]Resource, error) {
	rows, err := s.DB.QueryContext(
		ctx,
		`SELECT address, class, provider_ref, external_id, status, desired_hash, observed_json, protected, last_transition_at, last_error
		 FROM resources
		 ORDER BY address`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	resources := []Resource{}
	for rows.Next() {
		resource, err := scanResource(rows)
		if err != nil {
			return nil, err
		}
		resources = append(resources, resource)
	}
	return resources, rows.Err()
}

func (s *Store) RemoveResource(ctx context.Context, address string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM resources WHERE address=?`, address)
	return err
}

func (s *Store) RecordEvent(ctx context.Context, command, subject, level, message string, attrs any) error {
	attrsJSON, err := marshalAttrs(attrs)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(
		ctx,
		`INSERT INTO events(timestamp, command, subject, level, message, attrs_json) VALUES (?, ?, ?, ?, ?, ?)`,
		time.Now().UTC().Format(time.RFC3339),
		command,
		subject,
		level,
		message,
		attrsJSON,
	)
	return err
}

func (s *Store) StartApply(ctx context.Context, plan any) (int64, error) {
	planJSON, err := marshalAttrs(plan)
	if err != nil {
		return 0, err
	}
	result, err := s.DB.ExecContext(
		ctx,
		`INSERT INTO applies(started_at, status, plan_json) VALUES (?, ?, ?)`,
		time.Now().UTC().Format(time.RFC3339),
		"running",
		planJSON,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func (s *Store) FinishApply(ctx context.Context, id int64, status string) error {
	if id == 0 {
		return nil
	}
	_, err := s.DB.ExecContext(
		ctx,
		`UPDATE applies SET finished_at=?, status=? WHERE id=?`,
		time.Now().UTC().Format(time.RFC3339),
		status,
		id,
	)
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanResource(row scanner) (Resource, error) {
	var resource Resource
	var protected int
	var transition string
	if err := row.Scan(
		&resource.Address,
		&resource.Class,
		&resource.ProviderRef,
		&resource.ExternalID,
		&resource.Status,
		&resource.DesiredHash,
		&resource.ObservedJSON,
		&protected,
		&transition,
		&resource.LastError,
	); err != nil {
		return Resource{}, err
	}
	resource.Protected = protected != 0
	if parsed, err := time.Parse(time.RFC3339, transition); err == nil {
		resource.LastTransitionAt = parsed
	}
	return resource, nil
}

func marshalAttrs(attrs any) (string, error) {
	if attrs == nil {
		return "{}", nil
	}
	data, err := json.Marshal(attrs)
	if err != nil {
		return "", fmt.Errorf("marshal attrs: %w", err)
	}
	return string(data), nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
