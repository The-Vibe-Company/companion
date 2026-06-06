package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadMissingRegistryReturnsEmptyVersionedRegistry(t *testing.T) {
	t.Setenv("COMPANION_HOME", t.TempDir())

	reg, err := Load()
	if err != nil {
		t.Fatalf("load missing registry: %v", err)
	}

	if reg.Version != 1 {
		t.Fatalf("version = %d, want 1", reg.Version)
	}
	if reg.Current != "" {
		t.Fatalf("current = %q, want empty", reg.Current)
	}
	if len(reg.Workspaces) != 0 {
		t.Fatalf("workspaces = %d, want 0", len(reg.Workspaces))
	}
}

func TestUpsertNormalizesSortsAndPersistsWorkspaces(t *testing.T) {
	home := t.TempDir()
	t.Setenv("COMPANION_HOME", home)
	base := t.TempDir()

	alphaPath := filepath.Join(base, "alpha")
	betaPath := filepath.Join(base, "beta")
	if err := Upsert(WorkspaceRecord{Name: "beta", Path: betaPath, ControlPlaneApp: "cp-beta"}, true); err != nil {
		t.Fatalf("upsert beta: %v", err)
	}
	if err := Upsert(WorkspaceRecord{Name: "alpha", Path: alphaPath, TailscaleHostname: "alpha.tailnet.ts.net"}, false); err != nil {
		t.Fatalf("upsert alpha: %v", err)
	}

	reg := readRegistryFile(t, home)
	if reg.Current != "beta" {
		t.Fatalf("current = %q, want beta", reg.Current)
	}
	if got, want := workspaceNames(reg.Workspaces), []string{"alpha", "beta"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("workspace order = %v, want %v", got, want)
	}
	if reg.Workspaces[0].Path != alphaPath {
		t.Fatalf("alpha path = %q, want %q", reg.Workspaces[0].Path, alphaPath)
	}
	if reg.Workspaces[0].TailscaleHostname != "alpha.tailnet.ts.net" {
		t.Fatalf("alpha tailscale hostname = %q", reg.Workspaces[0].TailscaleHostname)
	}
	if reg.Workspaces[1].ControlPlaneApp != "cp-beta" {
		t.Fatalf("beta control plane app = %q", reg.Workspaces[1].ControlPlaneApp)
	}

	if err := Upsert(WorkspaceRecord{Name: "beta", Path: filepath.Join(base, "beta-renamed")}, false); err != nil {
		t.Fatalf("replace beta: %v", err)
	}
	reg, err := Load()
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	if len(reg.Workspaces) != 2 {
		t.Fatalf("workspaces = %d, want 2", len(reg.Workspaces))
	}
	if reg.Workspaces[1].Path != filepath.Join(base, "beta-renamed") {
		t.Fatalf("replaced beta path = %q", reg.Workspaces[1].Path)
	}
}

func TestCurrentUseGetAndRemove(t *testing.T) {
	t.Setenv("COMPANION_HOME", t.TempDir())
	base := t.TempDir()
	if err := Upsert(WorkspaceRecord{Name: "alpha", Path: filepath.Join(base, "alpha")}, true); err != nil {
		t.Fatalf("upsert alpha: %v", err)
	}
	if err := Upsert(WorkspaceRecord{Name: "beta", Path: filepath.Join(base, "beta")}, true); err != nil {
		t.Fatalf("upsert beta: %v", err)
	}

	current, ok, err := Current()
	if err != nil {
		t.Fatalf("current: %v", err)
	}
	if !ok || current.Name != "beta" {
		t.Fatalf("current = (%q, %v), want beta true", current.Name, ok)
	}

	if err := Use("alpha"); err != nil {
		t.Fatalf("use alpha: %v", err)
	}
	current, ok, err = Current()
	if err != nil {
		t.Fatalf("current after use: %v", err)
	}
	if !ok || current.Name != "alpha" {
		t.Fatalf("current after use = (%q, %v), want alpha true", current.Name, ok)
	}

	got, ok, err := Get("beta")
	if err != nil {
		t.Fatalf("get beta: %v", err)
	}
	if !ok || got.Name != "beta" {
		t.Fatalf("get beta = (%q, %v), want beta true", got.Name, ok)
	}

	if err := Remove("alpha"); err != nil {
		t.Fatalf("remove current alpha: %v", err)
	}
	current, ok, err = Current()
	if err != nil {
		t.Fatalf("current after remove: %v", err)
	}
	if !ok || current.Name != "beta" {
		t.Fatalf("current after remove = (%q, %v), want beta true", current.Name, ok)
	}
}

func TestRegistryReportsUsefulErrors(t *testing.T) {
	home := t.TempDir()
	t.Setenv("COMPANION_HOME", home)

	if err := Upsert(WorkspaceRecord{Path: t.TempDir()}, false); err == nil || !strings.Contains(err.Error(), "workspace name is required") {
		t.Fatalf("missing name error = %v", err)
	}
	if err := Upsert(WorkspaceRecord{Name: "alpha"}, false); err == nil || !strings.Contains(err.Error(), "workspace path is required") {
		t.Fatalf("missing path error = %v", err)
	}
	if err := Use("missing"); err == nil || !strings.Contains(err.Error(), `workspace "missing" is not registered`) {
		t.Fatalf("use missing error = %v", err)
	}
	if err := Remove("missing"); err == nil || !strings.Contains(err.Error(), `workspace "missing" is not registered`) {
		t.Fatalf("remove missing error = %v", err)
	}

	if err := Save(Registry{Current: "ghost", Workspaces: []WorkspaceRecord{{Name: "alpha", Path: t.TempDir()}}}); err != nil {
		t.Fatalf("save ghost current: %v", err)
	}
	if _, _, err := Current(); err == nil || !strings.Contains(err.Error(), `current workspace "ghost" is not registered`) {
		t.Fatalf("ghost current error = %v", err)
	}

	path, err := Path()
	if err != nil {
		t.Fatalf("registry path: %v", err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatalf("write invalid registry: %v", err)
	}
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "read ") {
		t.Fatalf("invalid registry error = %v", err)
	}
}

func readRegistryFile(t *testing.T, home string) Registry {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, filename))
	if err != nil {
		t.Fatalf("read registry file: %v", err)
	}
	var reg Registry
	if err := json.Unmarshal(data, &reg); err != nil {
		t.Fatalf("parse registry file: %v", err)
	}
	return reg
}

func workspaceNames(records []WorkspaceRecord) []string {
	names := make([]string, 0, len(records))
	for _, record := range records {
		names = append(names, record.Name)
	}
	return names
}
