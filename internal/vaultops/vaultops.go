package vaultops

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/fly"
)

type BackupResult struct {
	AgentID   string
	App       string
	MachineID string
	VaultPath string
	LocalPath string
}

type RestoreResult struct {
	AgentID        string
	App            string
	MachineID      string
	VaultPath      string
	PreviousVault  string
	BackupFilePath string
}

func Backup(ctx context.Context, provider fly.Provider, agent config.Agent, backupDir string, now time.Time) (BackupResult, error) {
	if !agent.DefaultVault.Enabled {
		return BackupResult{}, fmt.Errorf("agent %s default vault is disabled", agent.ID)
	}
	machine, err := startedMachine(ctx, provider, agent.FlyApp)
	if err != nil {
		return BackupResult{}, err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	name := fmt.Sprintf("%s-granite-%s.tgz", agent.ID, now.UTC().Format("20060102T150405Z"))
	localPath := filepath.Join(backupDir, name)
	remotePath := "/tmp/" + name
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return BackupResult{}, err
	}
	command := remoteShell(strings.Join([]string{
		"set -e",
		"test -d " + shellQuote(agent.DefaultVault.Path),
		"tar -C " + shellQuote(agent.DefaultVault.Path) + " -czf " + shellQuote(remotePath) + " .",
	}, "; "))
	if _, err := provider.SSHConsole(ctx, agent.FlyApp, machine.ID, command); err != nil {
		return BackupResult{}, err
	}
	if err := provider.SFTPGet(ctx, agent.FlyApp, machine.ID, remotePath, localPath); err != nil {
		return BackupResult{}, err
	}
	_, _ = provider.SSHConsole(ctx, agent.FlyApp, machine.ID, remoteShell("rm -f "+shellQuote(remotePath)))
	return BackupResult{
		AgentID:   agent.ID,
		App:       agent.FlyApp,
		MachineID: machine.ID,
		VaultPath: agent.DefaultVault.Path,
		LocalPath: localPath,
	}, nil
}

func Restore(ctx context.Context, provider fly.Provider, agent config.Agent, backupFilePath string, now time.Time) (RestoreResult, error) {
	if !agent.DefaultVault.Enabled {
		return RestoreResult{}, fmt.Errorf("agent %s default vault is disabled", agent.ID)
	}
	if _, err := os.Stat(backupFilePath); err != nil {
		return RestoreResult{}, err
	}
	machine, err := startedMachine(ctx, provider, agent.FlyApp)
	if err != nil {
		return RestoreResult{}, err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	remotePath := "/tmp/" + filepath.Base(backupFilePath)
	previousPath := strings.TrimRight(agent.DefaultVault.Path, "/") + ".before-restore-" + now.UTC().Format("20060102T150405Z")
	if err := provider.SFTPPut(ctx, agent.FlyApp, machine.ID, backupFilePath, remotePath); err != nil {
		return RestoreResult{}, err
	}
	command := remoteShell(strings.Join([]string{
		"set -e",
		"test -f " + shellQuote(remotePath),
		"mkdir -p " + shellQuote(path.Dir(agent.DefaultVault.Path)),
		"if [ -d " + shellQuote(agent.DefaultVault.Path) + " ]; then mv " + shellQuote(agent.DefaultVault.Path) + " " + shellQuote(previousPath) + "; fi",
		"mkdir -p " + shellQuote(agent.DefaultVault.Path),
		"tar -xzf " + shellQuote(remotePath) + " -C " + shellQuote(agent.DefaultVault.Path),
		"rm -f " + shellQuote(remotePath),
	}, "; "))
	if _, err := provider.SSHConsole(ctx, agent.FlyApp, machine.ID, command); err != nil {
		return RestoreResult{}, err
	}
	return RestoreResult{
		AgentID:        agent.ID,
		App:            agent.FlyApp,
		MachineID:      machine.ID,
		VaultPath:      agent.DefaultVault.Path,
		PreviousVault:  previousPath,
		BackupFilePath: backupFilePath,
	}, nil
}

func startedMachine(ctx context.Context, provider fly.Provider, app string) (fly.Machine, error) {
	machines, err := provider.ListMachines(ctx, app)
	if err != nil {
		return fly.Machine{}, err
	}
	machine, ok := fly.SelectStartedMachine(machines)
	if !ok {
		return fly.Machine{}, fmt.Errorf("no machine found for %s", app)
	}
	if machine.State != "started" {
		return fly.Machine{}, fmt.Errorf("no started machine found for %s", app)
	}
	return machine, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func remoteShell(script string) string {
	return "sh -lc " + shellQuote(script)
}
