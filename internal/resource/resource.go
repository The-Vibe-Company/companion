package resource

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/deps"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/render"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

const (
	ClassManaged  = "managed"
	ClassObserved = "observed"
	ClassDerived  = "derived"
	ClassAction   = "action"
)

type Resource struct {
	Address     string            `json:"address"`
	Type        string            `json:"type"`
	Class       string            `json:"class"`
	ProviderRef string            `json:"provider_ref"`
	ExternalID  string            `json:"external_id,omitempty"`
	DesiredHash string            `json:"desired_hash"`
	Protected   bool              `json:"protected"`
	Absent      bool              `json:"absent"`
	DependsOn   []string          `json:"depends_on,omitempty"`
	Agent       *config.Agent     `json:"-"`
	OpenWebUI   *config.OpenWebUI `json:"-"`
	Desired     map[string]any    `json:"desired,omitempty"`
}

type Graph struct {
	Resources []Resource `json:"resources"`
	byAddress map[string]Resource
}

type Change struct {
	Kind        string `json:"kind"`
	Action      string `json:"action"`
	Address     string `json:"address"`
	Class       string `json:"class"`
	ProviderRef string `json:"provider_ref,omitempty"`
	ExternalID  string `json:"external_id,omitempty"`
	Message     string `json:"message"`
	DesiredHash string `json:"desired_hash,omitempty"`
	Protected   bool   `json:"protected,omitempty"`
}

type Plan struct {
	Changes []Change `json:"changes"`
}

type Options struct {
	Root                  string
	GeneratedDir          string
	Env                   map[string]string
	Targets               []string
	DestroyTargets        []string
	DestroyData           bool
	BackupFirst           bool
	AllowProtectedDestroy bool
}

func (p Plan) String() string {
	if len(p.Changes) == 0 {
		return "= no-op"
	}
	lines := make([]string, 0, len(p.Changes))
	for _, change := range p.Changes {
		message := strings.TrimSpace(change.Message)
		if message != "" {
			lines = append(lines, fmt.Sprintf("%s %s %s %s", change.Kind, change.Action, change.Address, message))
		} else {
			lines = append(lines, fmt.Sprintf("%s %s %s", change.Kind, change.Action, change.Address))
		}
	}
	return strings.Join(lines, "\n")
}

func (p Plan) JSON() ([]byte, error) {
	return json.MarshalIndent(p, "", "  ")
}

func Compile(ws *workspace.Workspace, root string) (Graph, error) {
	resources := []Resource{}
	for _, agent := range ws.Config.Agents {
		hydrated, err := hydrateAgentIdentity(root, agent)
		if err != nil {
			return Graph{}, err
		}
		agent = hydrated
		absent := agent.Lifecycle == "absent"
		requiredSecrets := render.RequiredAgentSecrets(agent)
		agentConfigHash, err := hashAgentConfig(agent)
		if err != nil {
			return Graph{}, err
		}
		resources = append(resources,
			Resource{Address: "fly_app.agent." + agent.ID, Type: "fly_app", Class: ClassManaged, ProviderRef: agent.Runtime, ExternalID: agent.FlyApp, DesiredHash: hashValue(agent.FlyApp), Protected: agent.Protect, Absent: absent, Agent: &agent, Desired: map[string]any{"app": agent.FlyApp}},
			Resource{Address: "fly_volume.agent_data." + agent.ID, Type: "fly_volume", Class: ClassManaged, ProviderRef: agent.Runtime, DesiredHash: hashMap(map[string]any{"app": agent.FlyApp, "name": agent.VolumeName, "region": agent.Region, "size_gb": agent.VolumeSizeGB}), Protected: true, Absent: absent, DependsOn: []string{"fly_app.agent." + agent.ID}, Agent: &agent, Desired: map[string]any{"app": agent.FlyApp, "name": agent.VolumeName}},
			Resource{Address: "fly_secrets.agent." + agent.ID, Type: "fly_secrets", Class: ClassManaged, ProviderRef: agent.Runtime, DesiredHash: hashStringSlice(requiredSecrets), Protected: agent.Protect, Absent: absent, DependsOn: []string{"fly_app.agent." + agent.ID}, Agent: &agent, Desired: map[string]any{"names": requiredSecrets}},
			Resource{Address: "fly_config.agent." + agent.ID, Type: "fly_config", Class: ClassManaged, ProviderRef: agent.Runtime, DesiredHash: agentConfigHash, Protected: agent.Protect, Absent: absent, DependsOn: []string{"fly_app.agent." + agent.ID}, Agent: &agent},
			Resource{Address: "rollout.agent." + agent.ID, Type: "rollout", Class: ClassAction, ProviderRef: agent.Runtime, DesiredHash: agentConfigHash, Protected: agent.Protect, Absent: absent, DependsOn: []string{"fly_app.agent." + agent.ID, "fly_volume.agent_data." + agent.ID, "fly_secrets.agent." + agent.ID, "fly_config.agent." + agent.ID}, Agent: &agent},
			Resource{Address: "tailscale_device.agent." + agent.ID, Type: "tailscale_device", Class: ClassObserved, ProviderRef: agent.Network, DesiredHash: hashValue(agent.TailscaleHostname), Protected: agent.Protect, Absent: absent, DependsOn: []string{"rollout.agent." + agent.ID}, Agent: &agent},
		)
		if agent.DefaultVault.Enabled {
			resources = append(resources, Resource{Address: "granite_vault.default." + agent.ID, Type: "granite_vault", Class: ClassObserved, ProviderRef: agent.Runtime, DesiredHash: hashMap(map[string]any{"path": agent.DefaultVault.Path, "name": agent.DefaultVault.Name, "role": agent.DefaultVault.MCPRole}), Protected: true, Absent: absent, DependsOn: []string{"rollout.agent." + agent.ID}, Agent: &agent})
		}
	}
	if ws.Config.OpenWebUI.Enabled {
		webui := ws.Config.OpenWebUI
		absent := webui.Lifecycle == "absent"
		resources = append(resources,
			Resource{Address: "openwebui_config.main", Type: "openwebui_config", Class: ClassDerived, ProviderRef: webui.Runtime, DesiredHash: hashValue(webui.FlyApp), Protected: webui.Protect, Absent: absent, OpenWebUI: &webui},
			Resource{Address: "fly_app.openwebui.main", Type: "fly_app", Class: ClassManaged, ProviderRef: webui.Runtime, ExternalID: webui.FlyApp, DesiredHash: hashValue(webui.FlyApp), Protected: webui.Protect, Absent: absent, OpenWebUI: &webui, Desired: map[string]any{"app": webui.FlyApp}},
			Resource{Address: "fly_volume.openwebui_data.main", Type: "fly_volume", Class: ClassManaged, ProviderRef: webui.Runtime, DesiredHash: hashMap(map[string]any{"app": webui.FlyApp, "name": webui.VolumeName, "region": webui.Region, "size_gb": webui.VolumeSizeGB}), Protected: true, Absent: absent, DependsOn: []string{"fly_app.openwebui.main"}, OpenWebUI: &webui},
			Resource{Address: "fly_secrets.openwebui.main", Type: "fly_secrets", Class: ClassManaged, ProviderRef: webui.Runtime, DesiredHash: hashValue(webui.FlyApp), Protected: webui.Protect, Absent: absent, DependsOn: []string{"fly_app.openwebui.main", "openwebui_config.main"}, OpenWebUI: &webui},
			Resource{Address: "rollout.openwebui.main", Type: "rollout", Class: ClassAction, ProviderRef: webui.Runtime, DesiredHash: hashValue(webui.FlyApp), Protected: webui.Protect, Absent: absent, DependsOn: []string{"fly_app.openwebui.main", "fly_volume.openwebui_data.main", "fly_secrets.openwebui.main", "openwebui_config.main"}, OpenWebUI: &webui},
		)
	}
	graph := Graph{Resources: resources, byAddress: map[string]Resource{}}
	for _, resource := range resources {
		graph.byAddress[resource.Address] = resource
	}
	return graph, nil
}

func BuildPlan(ctx context.Context, ws *workspace.Workspace, store *state.Store, flyProvider fly.Provider, tsProvider tailscale.Provider, opts Options) (Plan, error) {
	graph, err := Compile(ws, defaultRoot(opts.Root, ws.Root))
	if err != nil {
		return Plan{}, err
	}
	selected := graph.Select(opts.Targets, opts.DestroyTargets)
	devices, err := tsProvider.Devices(ctx)
	if err != nil {
		return Plan{}, fmt.Errorf("inspect tailscale devices: %w", err)
	}
	changes := []Change{}
	for _, resource := range selected.Resources {
		change, err := planResource(ctx, ws, store, flyProvider, devices, resource, opts)
		if err != nil {
			return Plan{}, err
		}
		changes = append(changes, change)
	}
	desired := map[string]bool{}
	for _, resource := range graph.Resources {
		desired[resource.Address] = true
	}
	if store != nil && len(opts.Targets) == 0 && len(opts.DestroyTargets) == 0 {
		resources, err := store.ListResources(ctx)
		if err != nil {
			return Plan{}, err
		}
		for _, resource := range resources {
			if !desired[resource.Address] {
				changes = append(changes, Change{Kind: "!", Action: "orphan", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, ExternalID: resource.ExternalID, Message: "exists in state but is not desired"})
			}
		}
	}
	return Plan{Changes: changes}, nil
}

func Apply(ctx context.Context, ws *workspace.Workspace, store *state.Store, flyProvider fly.Provider, tsProvider tailscale.Provider, opts Options) (Plan, error) {
	plan, err := BuildPlan(ctx, ws, store, flyProvider, tsProvider, opts)
	if err != nil {
		return plan, err
	}
	applyID, err := store.StartApply(ctx, plan)
	if err != nil {
		return plan, err
	}
	status := "failed"
	defer func() {
		_ = store.FinishApply(context.Background(), applyID, status)
	}()
	graph, err := Compile(ws, defaultRoot(opts.Root, ws.Root))
	if err != nil {
		return plan, err
	}
	byAddress := graph.ByAddress()
	for _, change := range plan.Changes {
		if change.Action == "orphan" {
			if err := markOrphan(ctx, store, change); err != nil {
				return plan, err
			}
			continue
		}
		if change.Kind == "=" || change.Kind == "!" {
			continue
		}
		resource, ok := byAddress[change.Address]
		if !ok {
			if change.Action == "delete" {
				if err := store.RemoveResource(ctx, change.Address); err != nil {
					return plan, err
				}
			}
			continue
		}
		if err := applyResource(ctx, ws, store, flyProvider, tsProvider, resource, opts); err != nil {
			_ = store.UpsertResource(ctx, state.Resource{
				Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef,
				ExternalID: resource.ExternalID, Status: "failed", DesiredHash: resource.DesiredHash,
				ObservedJSON: "{}", Protected: resource.Protected, LastError: err.Error(),
			})
			return plan, err
		}
	}
	status = "succeeded"
	return plan, nil
}

func markOrphan(ctx context.Context, store *state.Store, change Change) error {
	if store == nil {
		return nil
	}
	resource, ok, err := store.GetResource(ctx, change.Address)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	resource.Status = "orphan"
	resource.LastTransitionAt = time.Now().UTC()
	resource.LastError = ""
	return store.UpsertResource(ctx, resource)
}

func (g Graph) ByAddress() map[string]Resource {
	if g.byAddress != nil {
		return g.byAddress
	}
	byAddress := map[string]Resource{}
	for _, resource := range g.Resources {
		byAddress[resource.Address] = resource
	}
	return byAddress
}

func (g Graph) Select(targets, destroyTargets []string) Graph {
	if len(targets) == 0 && len(destroyTargets) == 0 {
		return g
	}
	targetSet := map[string]bool{}
	for _, target := range append(append([]string{}, targets...), destroyTargets...) {
		for _, address := range g.matchingAddresses(target) {
			targetSet[address] = true
			g.addDependencies(address, targetSet)
		}
	}
	selected := []Resource{}
	for _, resource := range g.Resources {
		if targetSet[resource.Address] {
			selected = append(selected, resource)
		}
	}
	return Graph{Resources: selected, byAddress: g.ByAddress()}
}

func (g Graph) matchingAddresses(target string) []string {
	if _, ok := g.ByAddress()[target]; ok {
		return []string{target}
	}
	matches := []string{}
	for _, resource := range g.Resources {
		if strings.HasSuffix(resource.Address, "."+target) || strings.Contains(resource.Address, "."+target+".") {
			matches = append(matches, resource.Address)
		}
	}
	sort.Strings(matches)
	return matches
}

func (g Graph) addDependencies(address string, targetSet map[string]bool) {
	resource, ok := g.ByAddress()[address]
	if !ok {
		return
	}
	for _, dependency := range resource.DependsOn {
		if !targetSet[dependency] {
			targetSet[dependency] = true
			g.addDependencies(dependency, targetSet)
		}
	}
}

func planResource(ctx context.Context, ws *workspace.Workspace, store *state.Store, flyProvider fly.Provider, devices []tailscale.Device, resource Resource, opts Options) (Change, error) {
	if contains(opts.DestroyTargets, resource.Address) || resource.Absent {
		if resource.Class == ClassObserved || resource.Class == ClassDerived {
			return Change{Kind: "=", Action: "no-op", Address: resource.Address, Class: resource.Class, Message: "not managed"}, nil
		}
		if resource.Protected && !opts.AllowProtectedDestroy {
			return Change{Kind: "!", Action: "blocked", Address: resource.Address, Class: resource.Class, Protected: true, Message: "protected resource requires explicit destroy confirmation"}, nil
		}
		return Change{Kind: "-", Action: "delete", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, ExternalID: resource.ExternalID, Protected: resource.Protected}, nil
	}
	switch resource.Type {
	case "fly_app":
		exists, err := flyProvider.AppExists(ctx, resourceFlyApp(resource))
		if err != nil {
			return Change{}, err
		}
		if !exists {
			return change("+", "create", resource, resourceFlyApp(resource)), nil
		}
		return change("=", "no-op", resource, resourceFlyApp(resource)), nil
	case "fly_volume":
		volume, matches, ok, err := readVolume(ctx, flyProvider, resource)
		if err != nil {
			return Change{}, err
		}
		if !ok {
			return change("+", "create", resource, resourceVolumeName(resource)), nil
		}
		if len(matches) > 1 {
			return Change{Kind: "!", Action: "drift", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, ExternalID: volume.ID, Message: "duplicate volume reused " + volume.ID, DesiredHash: resource.DesiredHash, Protected: resource.Protected}, nil
		}
		size := desiredSizeGB(resource)
		if volume.SizeGB < size {
			return Change{Kind: "~", Action: "update", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, ExternalID: volume.ID, Message: fmt.Sprintf("%dGB -> %dGB", volume.SizeGB, size), DesiredHash: resource.DesiredHash, Protected: resource.Protected}, nil
		}
		return change("=", "no-op", resource, volume.ID), nil
	case "fly_secrets":
		return planSecrets(ctx, flyProvider, resource)
	case "fly_config":
		return planByHash(ctx, store, resource, "render")
	case "rollout":
		if resource.OpenWebUI != nil {
			hash, err := hashOpenWebUIConfig(ws.Config.OpenWebUI, deps.OpenWebUIConnectionsForDevices(ws.Config, devices))
			if err != nil {
				return Change{}, err
			}
			resource.DesiredHash = hash
		}
		return planByHash(ctx, store, resource, "deploy")
	case "tailscale_device":
		return planTailscaleDevice(resource, devices), nil
	case "granite_vault":
		return change("=", "no-op", resource, "configured"), nil
	case "openwebui_config":
		return planOpenWebUIConfig(ctx, ws, store, devices, resource)
	default:
		return Change{}, fmt.Errorf("unknown resource type %s", resource.Type)
	}
}

func applyResource(ctx context.Context, ws *workspace.Workspace, store *state.Store, flyProvider fly.Provider, tsProvider tailscale.Provider, resource Resource, opts Options) error {
	if resource.Absent {
		return deleteResource(ctx, store, flyProvider, resource, opts)
	}
	switch resource.Type {
	case "fly_app":
		if err := flyProvider.CreateApp(ctx, resourceFlyApp(resource)); err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, resourceFlyApp(resource), map[string]any{"app": resourceFlyApp(resource)})
	case "fly_volume":
		app := resourceFlyApp(resource)
		if _, err := flyProvider.EnsureVolume(ctx, app, resourceVolumeName(resource), resourceRegion(resource), desiredSizeGB(resource)); err != nil {
			return err
		}
		volume, _, ok, err := readVolume(ctx, flyProvider, resource)
		if err != nil {
			return err
		}
		externalID := resourceVolumeName(resource)
		attrs := map[string]any{"app": app, "name": resourceVolumeName(resource)}
		if ok {
			externalID = volume.ID
			attrs["region"] = volume.Region
			attrs["size_gb"] = volume.SizeGB
			attrs["state"] = volume.State
			attrs["attached_machine_id"] = volume.AttachedMachineID
		}
		return upsertReady(ctx, store, resource, externalID, attrs)
	case "fly_secrets":
		values, names, err := secretValues(ctx, ws, tsProvider, resource, opts.Env)
		if err != nil {
			return err
		}
		if err := flyProvider.SetSecrets(ctx, resourceFlyApp(resource), values); err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, resourceFlyApp(resource), map[string]any{"names": names})
	case "fly_config":
		path, err := writeConfig(ctx, ws, tsProvider, resource, opts)
		if err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, path, map[string]any{"path": path})
	case "rollout":
		if resource.OpenWebUI != nil {
			devices, err := tsProvider.Devices(ctx)
			if err != nil {
				return err
			}
			hash, err := hashOpenWebUIConfig(*resource.OpenWebUI, deps.OpenWebUIConnectionsForDevices(ws.Config, devices))
			if err != nil {
				return err
			}
			resource.DesiredHash = hash
		}
		configPath := generatedPath(opts, resource)
		if err := flyProvider.Deploy(ctx, resourceFlyApp(resource), configPath); err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, resourceFlyApp(resource), map[string]any{"config": configPath})
	case "tailscale_device":
		devices, err := tsProvider.Devices(ctx)
		if err != nil {
			return err
		}
		device, ok := selectedTailscaleDevice(devices, resource.Agent.TailscaleHostname)
		if !ok {
			return nil
		}
		return upsertReady(ctx, store, resource, firstNonEmpty(device.ID, device.DNSName, device.HostName), map[string]any{"dns_name": strings.TrimSuffix(device.DNSName, "."), "online": device.Online, "ip": device.IP})
	case "openwebui_config":
		devices, err := tsProvider.Devices(ctx)
		if err != nil {
			return err
		}
		hash, err := hashOpenWebUIConfig(*resource.OpenWebUI, deps.OpenWebUIConnectionsForDevices(ws.Config, devices))
		if err != nil {
			return err
		}
		resource.DesiredHash = hash
		path, err := writeConfig(ctx, ws, tsProvider, resource, opts)
		if err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, path, map[string]any{"path": path})
	default:
		return nil
	}
}

func deleteResource(ctx context.Context, store *state.Store, flyProvider fly.Provider, resource Resource, opts Options) error {
	if resource.Protected && !opts.AllowProtectedDestroy {
		return fmt.Errorf("%s is protected", resource.Address)
	}
	switch resource.Type {
	case "fly_app":
		if err := flyProvider.DeleteApp(ctx, resourceFlyApp(resource)); err != nil {
			return err
		}
	case "fly_volume":
		if !opts.DestroyData || !opts.BackupFirst {
			return fmt.Errorf("%s requires --destroy-data --backup-first", resource.Address)
		}
		volume, _, ok, err := readVolume(ctx, flyProvider, resource)
		if err != nil {
			return err
		}
		if ok {
			if err := flyProvider.DeleteVolume(ctx, resourceFlyApp(resource), volume.ID); err != nil {
				return err
			}
		}
	}
	return store.RemoveResource(ctx, resource.Address)
}

func planSecrets(ctx context.Context, flyProvider fly.Provider, resource Resource) (Change, error) {
	existing, err := flyProvider.SecretNames(ctx, resourceFlyApp(resource))
	if err != nil {
		return Change{}, err
	}
	required := requiredSecretNames(resource)
	missing := []string{}
	for _, name := range required {
		if !existing[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return Change{Kind: "~", Action: "update", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, Message: strings.Join(missing, ","), DesiredHash: resource.DesiredHash, Protected: resource.Protected}, nil
	}
	return change("=", "no-op", resource, strings.Join(required, ",")), nil
}

func planByHash(ctx context.Context, store *state.Store, resource Resource, action string) (Change, error) {
	if store == nil {
		return Change{Kind: "~", Action: action, Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, DesiredHash: resource.DesiredHash, Protected: resource.Protected}, nil
	}
	observed, ok, err := store.GetResource(ctx, resource.Address)
	if err != nil {
		return Change{}, err
	}
	if !ok || observed.DesiredHash != resource.DesiredHash {
		return Change{Kind: "~", Action: action, Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, DesiredHash: resource.DesiredHash, Protected: resource.Protected}, nil
	}
	return change("=", "no-op", resource, observed.ExternalID), nil
}

func planTailscaleDevice(resource Resource, devices []tailscale.Device) Change {
	matches := tailscale.FindByHostname(devices, resource.Agent.TailscaleHostname)
	if len(matches) == 0 {
		return Change{Kind: "!", Action: "drift", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, Message: "missing " + resource.Agent.TailscaleHostname, DesiredHash: resource.DesiredHash, Protected: resource.Protected}
	}
	if len(matches) > 1 {
		return Change{Kind: "!", Action: "drift", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, ExternalID: matches[0].ID, Message: "multiple devices", DesiredHash: resource.DesiredHash, Protected: resource.Protected}
	}
	return change("=", "no-op", resource, firstNonEmpty(matches[0].ID, matches[0].DNSName))
}

func planOpenWebUIConfig(ctx context.Context, ws *workspace.Workspace, store *state.Store, devices []tailscale.Device, resource Resource) (Change, error) {
	hash, err := hashOpenWebUIConfig(ws.Config.OpenWebUI, deps.OpenWebUIConnectionsForDevices(ws.Config, devices))
	if err != nil {
		return Change{}, err
	}
	resource.DesiredHash = hash
	return planByHash(ctx, store, resource, "render")
}

func change(kind, action string, resource Resource, message string) Change {
	return Change{Kind: kind, Action: action, Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, ExternalID: resource.ExternalID, Message: message, DesiredHash: resource.DesiredHash, Protected: resource.Protected}
}

func upsertReady(ctx context.Context, store *state.Store, resource Resource, externalID string, attrs any) error {
	observedJSON, err := json.Marshal(attrs)
	if err != nil {
		return err
	}
	return store.UpsertResource(ctx, state.Resource{
		Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef,
		ExternalID: externalID, Status: "ready", DesiredHash: resource.DesiredHash,
		ObservedJSON: string(observedJSON), Protected: resource.Protected,
		LastTransitionAt: time.Now().UTC(),
	})
}

func writeConfig(ctx context.Context, ws *workspace.Workspace, tsProvider tailscale.Provider, resource Resource, opts Options) (string, error) {
	var data string
	var err error
	if resource.Agent != nil {
		data, err = render.AgentFlyTOML(*resource.Agent)
	} else {
		devices, tsErr := tsProvider.Devices(ctx)
		if tsErr != nil {
			return "", tsErr
		}
		data, err = render.OpenWebUIFlyTOML(*resource.OpenWebUI, deps.OpenWebUIConnectionsForDevices(ws.Config, devices))
	}
	if err != nil {
		return "", err
	}
	path := generatedPath(opts, resource)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func generatedPath(opts Options, resource Resource) string {
	dir := opts.GeneratedDir
	if dir == "" {
		dir = filepath.Join(defaultRoot(opts.Root, "."), ".companion", "generated")
	}
	name := strings.ReplaceAll(resource.Address, ".", "-")
	if resource.Agent != nil {
		name = "fly." + resource.Agent.ID
	}
	if resource.OpenWebUI != nil {
		name = "fly." + resource.OpenWebUI.ID
	}
	return filepath.Join(dir, name+".toml")
}

func readVolume(ctx context.Context, flyProvider fly.Provider, resource Resource) (fly.Volume, []fly.Volume, bool, error) {
	volumes, err := flyProvider.ListVolumes(ctx, resourceFlyApp(resource))
	if err != nil {
		return fly.Volume{}, nil, false, err
	}
	selected, matches, ok := fly.SelectVolume(volumes, resourceVolumeName(resource))
	return selected, matches, ok, nil
}

func secretValues(ctx context.Context, ws *workspace.Workspace, tsProvider tailscale.Provider, resource Resource, env map[string]string) (map[string]string, []string, error) {
	required := requiredSecretNames(resource)
	values := map[string]string{}
	missing := []string{}
	if resource.OpenWebUI != nil {
		devices, err := tsProvider.Devices(ctx)
		if err != nil {
			return nil, nil, err
		}
		connections := deps.OpenWebUIConnectionsForDevices(ws.Config, devices)
		values, err := render.OpenWebUISecretValues(*resource.OpenWebUI, connections, env)
		if err != nil {
			return nil, nil, err
		}
		return values, render.RequiredOpenWebUIFlySecrets(*resource.OpenWebUI), nil
	}
	for _, name := range required {
		if env[name] == "" {
			missing = append(missing, name)
			continue
		}
		values[name] = env[name]
	}
	if len(missing) > 0 {
		return nil, nil, fmt.Errorf("set %s in .env or your local environment before apply", strings.Join(missing, ", "))
	}
	return values, required, nil
}

func requiredSecretNames(resource Resource) []string {
	if resource.Agent != nil {
		return render.RequiredAgentSecrets(*resource.Agent)
	}
	if resource.OpenWebUI != nil {
		return render.RequiredOpenWebUIFlySecrets(*resource.OpenWebUI)
	}
	return nil
}

func resourceFlyApp(resource Resource) string {
	if resource.Agent != nil {
		return resource.Agent.FlyApp
	}
	if resource.OpenWebUI != nil {
		return resource.OpenWebUI.FlyApp
	}
	if value, ok := resource.Desired["app"].(string); ok {
		return value
	}
	return resource.ExternalID
}

func resourceVolumeName(resource Resource) string {
	if resource.Agent != nil {
		return resource.Agent.VolumeName
	}
	if resource.OpenWebUI != nil {
		return resource.OpenWebUI.VolumeName
	}
	if value, ok := resource.Desired["name"].(string); ok {
		return value
	}
	return "data"
}

func resourceRegion(resource Resource) string {
	if resource.Agent != nil {
		return resource.Agent.Region
	}
	if resource.OpenWebUI != nil {
		return resource.OpenWebUI.Region
	}
	return "cdg"
}

func desiredSizeGB(resource Resource) int {
	if resource.Agent != nil {
		return resource.Agent.VolumeSizeGB
	}
	if resource.OpenWebUI != nil {
		return resource.OpenWebUI.VolumeSizeGB
	}
	return 1
}

func hydrateAgentIdentity(root string, agent config.Agent) (config.Agent, error) {
	if !agent.Identity.Enabled || agent.Identity.Soul != "" {
		return agent, nil
	}
	path := agent.Identity.Path
	if path == "" {
		return agent, nil
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, filepath.FromSlash(path))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return agent, fmt.Errorf("read identity for agent %s: %w", agent.ID, err)
	}
	agent.Identity.Soul = string(data)
	return agent, nil
}

func hashAgentConfig(agent config.Agent) (string, error) {
	data, err := render.AgentFlyTOML(agent)
	if err != nil {
		return "", err
	}
	return hashValue(data), nil
}

func hashOpenWebUIConfig(webui config.OpenWebUI, connections []config.OpenWebUIConnection) (string, error) {
	data, err := render.OpenWebUIFlyTOML(webui, connections)
	if err != nil {
		return "", err
	}
	return hashValue(data), nil
}

func hashMap(value map[string]any) string {
	data, _ := json.Marshal(value)
	return hashValue(string(data))
}

func hashStringSlice(values []string) string {
	copied := append([]string(nil), values...)
	sort.Strings(copied)
	return hashMap(map[string]any{"values": copied})
}

func hashValue(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func selectedTailscaleDevice(devices []tailscale.Device, hostname string) (tailscale.Device, bool) {
	matches := tailscale.FindByHostname(devices, hostname)
	if len(matches) == 0 {
		return tailscale.Device{}, false
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Online != matches[j].Online {
			return matches[i].Online
		}
		return matches[i].DNSName < matches[j].DNSName
	})
	return matches[0], true
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func defaultRoot(root, fallback string) string {
	if root != "" {
		return root
	}
	return fallback
}
