package vaultops

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
)

func TestBackupRunsTarAndSFTPGet(t *testing.T) {
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly machines list -a app --json": {Stdout: `[{"id":"machine","state":"started"}]`},
	}}
	agent := testAgent()
	result, err := Backup(context.Background(), fly.New(runner), agent, t.TempDir(), time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if !strings.HasSuffix(result.LocalPath, "agent-granite-20260602T120000Z.tgz") {
		t.Fatalf("unexpected backup path: %s", result.LocalPath)
	}
	if !calledAll(runner, "tar -C", "/opt/data/.granite", "-czf", "agent-granite-20260602T120000Z.tgz") {
		t.Fatalf("expected remote tar command, got %#v", runner.Calls)
	}
	if !called(runner, "sftp get") {
		t.Fatalf("expected sftp get, got %#v", runner.Calls)
	}
}

func TestRestoreRequiresLocalBackupAndMovesPreviousVault(t *testing.T) {
	runner := &execx.FakeRunner{Responses: map[string]execx.Result{
		"fly machines list -a app --json": {Stdout: `[{"id":"machine","state":"started"}]`},
	}}
	backup := filepath.Join(t.TempDir(), "backup.tgz")
	if err := os.WriteFile(backup, []byte("not-a-real-tar-for-unit-test"), 0o644); err != nil {
		t.Fatalf("write backup: %v", err)
	}
	result, err := Restore(context.Background(), fly.New(runner), testAgent(), backup, time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.PreviousVault != "/opt/data/.granite.before-restore-20260602T120000Z" {
		t.Fatalf("unexpected previous vault path: %s", result.PreviousVault)
	}
	if !called(runner, "sftp put") || !calledAll(runner, "tar -xzf", "backup.tgz", "/opt/data/.granite") {
		t.Fatalf("expected sftp put and extract, got %#v", runner.Calls)
	}
}

func testAgent() config.Agent {
	return config.Agent{
		ID:     "agent",
		FlyApp: "app",
		DefaultVault: config.DefaultVault{
			Enabled: true,
			Path:    "/opt/data/.granite",
		},
	}
}

func called(runner *execx.FakeRunner, fragment string) bool {
	for _, call := range runner.Calls {
		if strings.Contains(strings.Join(call, " "), fragment) {
			return true
		}
	}
	return false
}

func calledAll(runner *execx.FakeRunner, fragments ...string) bool {
	for _, call := range runner.Calls {
		line := strings.Join(call, " ")
		matches := true
		for _, fragment := range fragments {
			if !strings.Contains(line, fragment) {
				matches = false
				break
			}
		}
		if matches {
			return true
		}
	}
	return false
}
