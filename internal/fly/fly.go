package fly

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/execx"
)

type Provider struct {
	Runner execx.Runner
}

type Volume struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	State             string `json:"state"`
	SizeGB            int    `json:"size_gb"`
	Region            string `json:"region"`
	Zone              string `json:"zone"`
	Encrypted         bool   `json:"encrypted"`
	AttachedMachineID string `json:"attached_machine_id"`
	CreatedAt         string `json:"created_at"`
}

type Machine struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	State      string   `json:"state"`
	Region     string   `json:"region"`
	InstanceID string   `json:"instance_id"`
	PrivateIP  string   `json:"private_ip"`
	ImageRef   ImageRef `json:"image_ref"`
	Config     struct {
		Image    string            `json:"image"`
		Env      map[string]string `json:"env"`
		Metadata map[string]string `json:"metadata"`
		Mounts   []struct {
			Name   string `json:"name"`
			Volume string `json:"volume"`
			Path   string `json:"path"`
			SizeGB int    `json:"size_gb"`
		} `json:"mounts"`
	} `json:"config"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
	ProcessGroup string `json:"process_group"`
}

type ImageRef struct {
	Registry   string            `json:"registry"`
	Repository string            `json:"repository"`
	Tag        string            `json:"tag"`
	Digest     string            `json:"digest"`
	Labels     map[string]string `json:"labels"`
}

type Secret struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

func New(runner execx.Runner) Provider {
	return Provider{Runner: runner}
}

func (p Provider) AppExists(ctx context.Context, app string) (bool, error) {
	result, err := p.Runner.Run(ctx, []string{"fly", "status", "-a", app})
	if err != nil {
		return false, err
	}
	if result.ExitCode == 0 {
		return true, nil
	}
	return false, nil
}

func (p Provider) CreateApp(ctx context.Context, app string) error {
	result, err := p.Runner.Run(ctx, []string{"fly", "apps", "create", app})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 && !strings.Contains(result.Stderr+result.Stdout, "Name has already been taken") {
		return fmt.Errorf("fly apps create failed: %s", strings.TrimSpace(result.Stderr))
	}
	return nil
}

func (p Provider) DeleteApp(ctx context.Context, app string) error {
	result, err := p.Runner.Run(ctx, []string{"fly", "apps", "destroy", app, "--yes"})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 && !strings.Contains(strings.ToLower(result.Stderr+result.Stdout), "could not find app") {
		return fmt.Errorf("fly apps destroy failed: %s", strings.TrimSpace(result.Stderr+result.Stdout))
	}
	return nil
}

func (p Provider) ListVolumes(ctx context.Context, app string) ([]Volume, error) {
	result, err := p.Runner.Run(ctx, []string{"fly", "volumes", "list", "-a", app, "--json"})
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, nil
	}
	var volumes []Volume
	if strings.TrimSpace(result.Stdout) == "" {
		return nil, nil
	}
	if err := json.Unmarshal([]byte(result.Stdout), &volumes); err != nil {
		return nil, err
	}
	return volumes, nil
}

func SelectVolume(volumes []Volume, name string) (Volume, []Volume, bool) {
	var matches []Volume
	for _, volume := range volumes {
		if volume.Name == name {
			matches = append(matches, volume)
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		leftAttached := matches[i].AttachedMachineID != ""
		rightAttached := matches[j].AttachedMachineID != ""
		if leftAttached != rightAttached {
			return leftAttached
		}
		return matches[i].CreatedAt < matches[j].CreatedAt
	})
	if len(matches) == 0 {
		return Volume{}, nil, false
	}
	return matches[0], matches, true
}

func (p Provider) EnsureVolume(ctx context.Context, app, name, region string, sizeGB int) (string, error) {
	volumes, err := p.ListVolumes(ctx, app)
	if err != nil {
		return "", err
	}
	selected, matches, ok := SelectVolume(volumes, name)
	if ok {
		message := fmt.Sprintf("= no-op volume %s %s", name, selected.ID)
		if len(matches) > 1 {
			message = fmt.Sprintf("! drift duplicate volume %s reused %s", name, selected.ID)
		}
		if selected.SizeGB < sizeGB {
			result, err := p.Runner.Run(ctx, []string{"fly", "volumes", "extend", selected.ID, "-a", app, "--size", fmt.Sprint(sizeGB), "--yes"})
			if err != nil {
				return "", err
			}
			if result.ExitCode != 0 {
				return "", fmt.Errorf("fly volumes extend failed: %s", strings.TrimSpace(result.Stderr))
			}
			return fmt.Sprintf("~ update volume %s %s %dGB", name, selected.ID, sizeGB), nil
		}
		return message, nil
	}

	result, err := p.Runner.Run(ctx, []string{"fly", "volumes", "create", name, "-a", app, "--region", region, "--size", fmt.Sprint(sizeGB), "--yes"})
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		return "", fmt.Errorf("fly volumes create failed: %s", strings.TrimSpace(result.Stderr))
	}
	return fmt.Sprintf("+ create volume %s", name), nil
}

func (p Provider) DeleteVolume(ctx context.Context, app, volumeID string) error {
	result, err := p.Runner.Run(ctx, []string{"fly", "volumes", "destroy", volumeID, "-a", app, "--yes"})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		text := strings.ToLower(result.Stderr + result.Stdout)
		if strings.Contains(text, "not found") || strings.Contains(text, "no volume") {
			return nil
		}
		return fmt.Errorf("fly volumes destroy failed: %s", strings.TrimSpace(result.Stderr+result.Stdout))
	}
	return nil
}

func (p Provider) SetSecrets(ctx context.Context, app string, secrets map[string]string) error {
	if len(secrets) == 0 {
		return nil
	}
	args := []string{"fly", "secrets", "set", "-a", app}
	for _, name := range sortedKeys(secrets) {
		args = append(args, fmt.Sprintf("%s=%s", name, secrets[name]))
	}
	result, err := p.Runner.Run(ctx, args)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("fly secrets set failed: %s", strings.TrimSpace(result.Stderr))
	}
	return nil
}

func (p Provider) SecretNames(ctx context.Context, app string) (map[string]bool, error) {
	result, err := p.Runner.Run(ctx, []string{"fly", "secrets", "list", "-a", app, "--json"})
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) == "" {
		return map[string]bool{}, nil
	}
	var secrets []Secret
	if err := json.Unmarshal([]byte(result.Stdout), &secrets); err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, secret := range secrets {
		if secret.Name != "" {
			names[secret.Name] = true
		}
	}
	return names, nil
}

func RedactedSecretsCommand(app string, secrets map[string]string) string {
	args := []string{"fly", "secrets", "set", "-a", app}
	for _, name := range sortedKeys(secrets) {
		args = append(args, name+"=...")
	}
	return execx.Quote(args)
}

func (p Provider) Deploy(ctx context.Context, app, configPath string) error {
	result, err := p.Runner.Run(ctx, []string{"fly", "deploy", ".", "-a", app, "-c", configPath, "--ha=false", "--remote-only"})
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("fly deploy failed: %s", strings.TrimSpace(result.Stderr))
	}
	return nil
}

func (p Provider) ListMachines(ctx context.Context, app string) ([]Machine, error) {
	result, err := p.Runner.Run(ctx, []string{"fly", "machines", "list", "-a", app, "--json"})
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) == "" {
		return nil, nil
	}
	var machines []Machine
	if err := json.Unmarshal([]byte(result.Stdout), &machines); err != nil {
		return nil, err
	}
	return machines, nil
}

func SelectStartedMachine(machines []Machine) (Machine, bool) {
	for _, machine := range machines {
		if machine.State == "started" {
			return machine, true
		}
	}
	if len(machines) == 0 {
		return Machine{}, false
	}
	return machines[0], true
}

func (p Provider) SSHConsole(ctx context.Context, app, machineID, command string) (execx.Result, error) {
	args := []string{"fly", "ssh", "console", "-a", app, "-q"}
	if machineID != "" {
		args = append(args, "--machine", machineID)
	}
	args = append(args, "-C", command)
	result, err := p.Runner.Run(ctx, args)
	if err != nil {
		return result, err
	}
	if result.ExitCode != 0 {
		return result, fmt.Errorf("fly ssh console failed: %s", strings.TrimSpace(result.Stderr+result.Stdout))
	}
	return result, nil
}

func (p Provider) SFTPGet(ctx context.Context, app, machineID, remotePath, localPath string) error {
	args := []string{"fly", "ssh", "sftp", "get", "-a", app, "-q"}
	if machineID != "" {
		args = append(args, "--machine", machineID)
	}
	args = append(args, remotePath, localPath)
	result, err := p.Runner.Run(ctx, args)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("fly ssh sftp get failed: %s", strings.TrimSpace(result.Stderr+result.Stdout))
	}
	return nil
}

func (p Provider) SFTPPut(ctx context.Context, app, machineID, localPath, remotePath string) error {
	args := []string{"fly", "ssh", "sftp", "put", "-a", app, "-q"}
	if machineID != "" {
		args = append(args, "--machine", machineID)
	}
	args = append(args, localPath, remotePath)
	result, err := p.Runner.Run(ctx, args)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("fly ssh sftp put failed: %s", strings.TrimSpace(result.Stderr+result.Stdout))
	}
	return nil
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
