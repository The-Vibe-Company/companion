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
	Provider   string
	Kind       string
	DesiredID  string
	ExternalID string
	AttrsJSON  string
	ObservedAt time.Time
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
	statements := []string{
		`CREATE TABLE IF NOT EXISTS resources (
			provider TEXT NOT NULL,
			kind TEXT NOT NULL,
			desired_id TEXT NOT NULL,
			external_id TEXT NOT NULL,
			attrs_json TEXT NOT NULL,
			observed_at TEXT NOT NULL,
			PRIMARY KEY (provider, kind, desired_id, external_id)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS resources_desired_idx
		 ON resources(provider, kind, desired_id)`,
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

func (s *Store) UpsertResource(ctx context.Context, resource Resource) error {
	if resource.ObservedAt.IsZero() {
		resource.ObservedAt = time.Now().UTC()
	}
	_, err := s.DB.ExecContext(
		ctx,
		`INSERT INTO resources(provider, kind, desired_id, external_id, attrs_json, observed_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(provider, kind, desired_id)
		 DO UPDATE SET external_id=excluded.external_id, attrs_json=excluded.attrs_json, observed_at=excluded.observed_at`,
		resource.Provider,
		resource.Kind,
		resource.DesiredID,
		resource.ExternalID,
		resource.AttrsJSON,
		resource.ObservedAt.Format(time.RFC3339),
	)
	return err
}

func (s *Store) ImportResource(ctx context.Context, resource Resource) error {
	if resource.ObservedAt.IsZero() {
		resource.ObservedAt = time.Now().UTC()
	}
	_, err := s.DB.ExecContext(
		ctx,
		`INSERT INTO resources(provider, kind, desired_id, external_id, attrs_json, observed_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(provider, kind, desired_id)
		 DO UPDATE SET external_id=excluded.external_id, attrs_json=excluded.attrs_json, observed_at=excluded.observed_at`,
		resource.Provider,
		resource.Kind,
		resource.DesiredID,
		resource.ExternalID,
		resource.AttrsJSON,
		resource.ObservedAt.Format(time.RFC3339),
	)
	return err
}

func (s *Store) ListResources(ctx context.Context) ([]Resource, error) {
	rows, err := s.DB.QueryContext(
		ctx,
		`SELECT provider, kind, desired_id, external_id, attrs_json, observed_at
		 FROM resources
		 ORDER BY provider, kind, desired_id, external_id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	resources := []Resource{}
	for rows.Next() {
		var resource Resource
		var observedAt string
		if err := rows.Scan(
			&resource.Provider,
			&resource.Kind,
			&resource.DesiredID,
			&resource.ExternalID,
			&resource.AttrsJSON,
			&observedAt,
		); err != nil {
			return nil, err
		}
		parsed, err := time.Parse(time.RFC3339, observedAt)
		if err == nil {
			resource.ObservedAt = parsed
		}
		resources = append(resources, resource)
	}
	return resources, rows.Err()
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
