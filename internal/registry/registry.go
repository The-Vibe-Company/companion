package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

const filename = "workspaces.json"

type Registry struct {
	Version    int               `json:"version"`
	Current    string            `json:"current,omitempty"`
	Workspaces []WorkspaceRecord `json:"workspaces"`
}

type WorkspaceRecord struct {
	Name              string `json:"name"`
	Path              string `json:"path"`
	ControlPlaneApp   string `json:"control_plane_app,omitempty"`
	TailscaleHostname string `json:"tailscale_hostname,omitempty"`
}

func Home() (string, error) {
	if value := os.Getenv("COMPANION_HOME"); value != "" {
		return value, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".companion"), nil
}

func Path() (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, filename), nil
}

func Load() (Registry, error) {
	path, err := Path()
	if err != nil {
		return Registry{}, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Registry{Version: 1}, nil
	}
	if err != nil {
		return Registry{}, err
	}
	var reg Registry
	if err := json.Unmarshal(data, &reg); err != nil {
		return Registry{}, fmt.Errorf("read %s: %w", path, err)
	}
	if reg.Version == 0 {
		reg.Version = 1
	}
	return reg, nil
}

func Save(reg Registry) error {
	path, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	reg.Version = 1
	sort.SliceStable(reg.Workspaces, func(i, j int) bool {
		return reg.Workspaces[i].Name < reg.Workspaces[j].Name
	})
	data, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o600)
}

func Upsert(record WorkspaceRecord, setCurrent bool) error {
	if record.Name == "" {
		return fmt.Errorf("workspace name is required")
	}
	if record.Path == "" {
		return fmt.Errorf("workspace path is required")
	}
	absPath, err := filepath.Abs(record.Path)
	if err != nil {
		return err
	}
	record.Path = absPath
	reg, err := Load()
	if err != nil {
		return err
	}
	replaced := false
	for i, existing := range reg.Workspaces {
		if existing.Name == record.Name {
			reg.Workspaces[i] = record
			replaced = true
			break
		}
	}
	if !replaced {
		reg.Workspaces = append(reg.Workspaces, record)
	}
	if setCurrent || reg.Current == "" {
		reg.Current = record.Name
	}
	return Save(reg)
}

func Current() (WorkspaceRecord, bool, error) {
	reg, err := Load()
	if err != nil {
		return WorkspaceRecord{}, false, err
	}
	if reg.Current == "" {
		return WorkspaceRecord{}, false, nil
	}
	for _, record := range reg.Workspaces {
		if record.Name == reg.Current {
			return record, true, nil
		}
	}
	return WorkspaceRecord{}, false, fmt.Errorf("current workspace %q is not registered", reg.Current)
}

func Get(name string) (WorkspaceRecord, bool, error) {
	reg, err := Load()
	if err != nil {
		return WorkspaceRecord{}, false, err
	}
	for _, record := range reg.Workspaces {
		if record.Name == name {
			return record, true, nil
		}
	}
	return WorkspaceRecord{}, false, nil
}

func Use(name string) error {
	reg, err := Load()
	if err != nil {
		return err
	}
	for _, record := range reg.Workspaces {
		if record.Name == name {
			reg.Current = name
			return Save(reg)
		}
	}
	return fmt.Errorf("workspace %q is not registered", name)
}

func Remove(name string) error {
	reg, err := Load()
	if err != nil {
		return err
	}
	next := reg.Workspaces[:0]
	removed := false
	for _, record := range reg.Workspaces {
		if record.Name == name {
			removed = true
			continue
		}
		next = append(next, record)
	}
	if !removed {
		return fmt.Errorf("workspace %q is not registered", name)
	}
	reg.Workspaces = next
	if reg.Current == name {
		reg.Current = ""
		if len(reg.Workspaces) > 0 {
			reg.Current = reg.Workspaces[0].Name
		}
	}
	return Save(reg)
}
