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
	"github.com/The-Vibe-Company/companion/internal/provider"
	"github.com/The-Vibe-Company/companion/internal/render"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/status"
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
	Address      string               `json:"address"`
	Type         string               `json:"type"`
	Class        string               `json:"class"`
	ProviderRef  string               `json:"provider_ref"`
	ExternalID   string               `json:"external_id,omitempty"`
	DesiredHash  string               `json:"desired_hash"`
	Protected    bool                 `json:"protected"`
	Absent       bool                 `json:"absent"`
	DependsOn    []string             `json:"depends_on,omitempty"`
	Agent        *config.Agent        `json:"-"`
	OpenWebUI    *config.OpenWebUI    `json:"-"`
	Dashboard    *config.Dashboard    `json:"-"`
	ControlPlane *config.ControlPlane `json:"-"`
	Desired      map[string]any       `json:"desired,omitempty"`
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
	if ws.Config.Dashboard.Enabled {
		dash := ws.Config.Dashboard
		absent := dash.Lifecycle == "absent"
		// No fly_volume: the dashboard is stateless. dashboard_config.main holds
		// the fleet topology fingerprint, so adding/changing an agent re-triggers
		// rollout.dashboard.main on the next apply (same pattern as openwebui_config).
		resources = append(resources,
			Resource{Address: "dashboard_config.main", Type: "dashboard_config", Class: ClassDerived, ProviderRef: dash.Runtime, DesiredHash: hashValue(dash.FlyApp), Protected: dash.Protect, Absent: absent, Dashboard: &dash},
			Resource{Address: "fly_app.dashboard.main", Type: "fly_app", Class: ClassManaged, ProviderRef: dash.Runtime, ExternalID: dash.FlyApp, DesiredHash: hashValue(dash.FlyApp), Protected: dash.Protect, Absent: absent, Dashboard: &dash, Desired: map[string]any{"app": dash.FlyApp}},
			Resource{Address: "fly_secrets.dashboard.main", Type: "fly_secrets", Class: ClassManaged, ProviderRef: dash.Runtime, DesiredHash: hashStringSlice(render.RequiredDashboardFlySecrets(dash)), Protected: dash.Protect, Absent: absent, DependsOn: []string{"fly_app.dashboard.main"}, Dashboard: &dash, Desired: map[string]any{"names": render.RequiredDashboardFlySecrets(dash)}},
			Resource{Address: "rollout.dashboard.main", Type: "rollout", Class: ClassAction, ProviderRef: dash.Runtime, DesiredHash: hashValue(dash.FlyApp), Protected: dash.Protect, Absent: absent, DependsOn: []string{"fly_app.dashboard.main", "fly_secrets.dashboard.main", "dashboard_config.main"}, Dashboard: &dash},
		)
	}
	if ws.Config.ControlPlane.Enabled {
		control := ws.Config.ControlPlane
		absent := control.Lifecycle == "absent"
		configHash, err := hashControlPlaneConfig(control)
		if err != nil {
			return Graph{}, err
		}
		resources = append(resources,
			Resource{Address: "control_plane_config.main", Type: "control_plane_config", Class: ClassDerived, ProviderRef: control.Runtime, DesiredHash: configHash, Protected: control.Protect, Absent: absent, ControlPlane: &control},
			Resource{Address: "fly_app.control_plane.main", Type: "fly_app", Class: ClassManaged, ProviderRef: control.Runtime, ExternalID: control.FlyApp, DesiredHash: hashValue(control.FlyApp), Protected: control.Protect, Absent: absent, ControlPlane: &control, Desired: map[string]any{"app": control.FlyApp}},
			Resource{Address: "fly_volume.control_plane_workspace.main", Type: "fly_volume", Class: ClassManaged, ProviderRef: control.Runtime, DesiredHash: hashMap(map[string]any{"app": control.FlyApp, "name": control.VolumeName, "region": control.Region, "size_gb": control.VolumeSizeGB}), Protected: true, Absent: absent, DependsOn: []string{"fly_app.control_plane.main"}, ControlPlane: &control, Desired: map[string]any{"app": control.FlyApp, "name": control.VolumeName}},
			Resource{Address: "fly_secrets.control_plane.main", Type: "fly_secrets", Class: ClassManaged, ProviderRef: control.Runtime, DesiredHash: hashStringSlice(render.RequiredControlPlaneFlySecrets(control)), Protected: control.Protect, Absent: absent, DependsOn: []string{"fly_app.control_plane.main"}, ControlPlane: &control, Desired: map[string]any{"names": render.RequiredControlPlaneFlySecrets(control)}},
			Resource{Address: "rollout.control_plane.main", Type: "rollout", Class: ClassAction, ProviderRef: control.Runtime, DesiredHash: configHash, Protected: control.Protect, Absent: absent, DependsOn: []string{"fly_app.control_plane.main", "fly_volume.control_plane_workspace.main", "fly_secrets.control_plane.main", "control_plane_config.main"}, ControlPlane: &control},
			Resource{Address: "tailscale_device.control_plane.main", Type: "tailscale_device", Class: ClassObserved, ProviderRef: control.Network, DesiredHash: hashValue(control.TailscaleHostname), Protected: control.Protect, Absent: absent, DependsOn: []string{"rollout.control_plane.main"}, ControlPlane: &control},
		)
	}
	graph := Graph{Resources: resources, byAddress: map[string]Resource{}}
	for _, resource := range resources {
		graph.byAddress[resource.Address] = resource
	}
	return graph, nil
}

func BuildPlan(ctx context.Context, ws *workspace.Workspace, store *state.Store, providers provider.Set, opts Options) (Plan, error) {
	graph, err := Compile(ws, defaultRoot(opts.Root, ws.Root))
	if err != nil {
		return Plan{}, err
	}
	selected := graph.Select(opts.Targets, opts.DestroyTargets)
	devices, err := providers.AllDevices(ctx)
	if err != nil {
		return Plan{}, fmt.Errorf("inspect tailscale devices: %w", err)
	}
	changes := []Change{}
	for _, resource := range selected.Resources {
		change, err := planResource(ctx, ws, store, providers, devices, resource, opts)
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

func Apply(ctx context.Context, ws *workspace.Workspace, store *state.Store, providers provider.Set, opts Options) (Plan, error) {
	plan, err := BuildPlan(ctx, ws, store, providers, opts)
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
		if contains(opts.DestroyTargets, resource.Address) {
			if err := deleteResource(ctx, store, providers, resource, opts); err != nil {
				_ = store.UpsertResource(ctx, state.Resource{
					Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef,
					ExternalID: resource.ExternalID, Status: "failed", DesiredHash: resource.DesiredHash,
					ObservedJSON: "{}", Protected: resource.Protected, LastError: err.Error(),
				})
				return plan, err
			}
			continue
		}
		if err := applyResource(ctx, ws, store, providers, resource, opts); err != nil {
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

func WriteControlPlaneArtifacts(ws *workspace.Workspace, opts Options) (string, error) {
	if !ws.Config.ControlPlane.Enabled {
		return "", fmt.Errorf("control_plane is disabled in the workspace")
	}
	resource := Resource{
		Address:      "control_plane_config.main",
		Type:         "control_plane_config",
		Class:        ClassDerived,
		ProviderRef:  ws.Config.ControlPlane.Runtime,
		DesiredHash:  hashValue(ws.Config.ControlPlane.FlyApp),
		Protected:    ws.Config.ControlPlane.Protect,
		ControlPlane: &ws.Config.ControlPlane,
	}
	return writeConfig(context.Background(), ws, provider.Set{}, resource, opts)
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

func planResource(ctx context.Context, ws *workspace.Workspace, store *state.Store, providers provider.Set, devices []tailscale.Device, resource Resource, opts Options) (Change, error) {
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
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return Change{}, err
		}
		exists, err := flyProvider.AppExists(ctx, resourceFlyApp(resource))
		if err != nil {
			return Change{}, err
		}
		if !exists {
			return change("+", "create", resource, resourceFlyApp(resource)), nil
		}
		return change("=", "no-op", resource, resourceFlyApp(resource)), nil
	case "fly_volume":
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return Change{}, err
		}
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
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return Change{}, err
		}
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
		if resource.Dashboard != nil {
			hash, err := hashDashboardConfig(ws, devices)
			if err != nil {
				return Change{}, err
			}
			resource.DesiredHash = hash
		}
		if resource.ControlPlane != nil {
			hash, err := hashControlPlaneConfig(*resource.ControlPlane)
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
	case "dashboard_config":
		hash, err := hashDashboardConfig(ws, devices)
		if err != nil {
			return Change{}, err
		}
		resource.DesiredHash = hash
		return planByHash(ctx, store, resource, "render")
	case "control_plane_config":
		hash, err := hashControlPlaneConfig(*resource.ControlPlane)
		if err != nil {
			return Change{}, err
		}
		resource.DesiredHash = hash
		return planByHash(ctx, store, resource, "render")
	default:
		return Change{}, fmt.Errorf("unknown resource type %s", resource.Type)
	}
}

func applyResource(ctx context.Context, ws *workspace.Workspace, store *state.Store, providers provider.Set, resource Resource, opts Options) error {
	if resource.Absent {
		return deleteResource(ctx, store, providers, resource, opts)
	}
	switch resource.Type {
	case "fly_app":
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return err
		}
		if err := flyProvider.CreateApp(ctx, resourceFlyApp(resource)); err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, resourceFlyApp(resource), map[string]any{"app": resourceFlyApp(resource)})
	case "fly_volume":
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return err
		}
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
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return err
		}
		values, names, err := secretValues(ctx, ws, providers, resource, opts.Env)
		if err != nil {
			return err
		}
		if err := flyProvider.SetSecrets(ctx, resourceFlyApp(resource), values); err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, resourceFlyApp(resource), map[string]any{"names": names})
	case "fly_config":
		path, err := writeConfig(ctx, ws, providers, resource, opts)
		if err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, path, map[string]any{"path": path})
	case "rollout":
		if resource.OpenWebUI != nil {
			devices, err := providers.AllDevices(ctx)
			if err != nil {
				return err
			}
			hash, err := hashOpenWebUIConfig(*resource.OpenWebUI, deps.OpenWebUIConnectionsForDevices(ws.Config, devices))
			if err != nil {
				return err
			}
			resource.DesiredHash = hash
		}
		if resource.Dashboard != nil {
			devices, err := providers.AllDevices(ctx)
			if err != nil {
				return err
			}
			hash, err := hashDashboardConfig(ws, devices)
			if err != nil {
				return err
			}
			resource.DesiredHash = hash
		}
		if resource.ControlPlane != nil {
			hash, err := hashControlPlaneConfig(*resource.ControlPlane)
			if err != nil {
				return err
			}
			resource.DesiredHash = hash
		}
		configPath := generatedPath(opts, resource)
		rolloutProvider, err := providers.RolloutFor(resource.ProviderRef)
		if err != nil {
			return err
		}
		if err := rolloutProvider.Deploy(ctx, resourceFlyApp(resource), configPath); err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, resourceFlyApp(resource), map[string]any{"config": configPath})
	case "tailscale_device":
		devices, err := providers.Devices(ctx, resource.ProviderRef)
		if err != nil {
			return err
		}
		device, ok := selectedTailscaleDevice(devices, resourceTailscaleHostname(resource))
		if !ok {
			return nil
		}
		return upsertReady(ctx, store, resource, firstNonEmpty(device.ID, device.DNSName, device.HostName), map[string]any{"dns_name": strings.TrimSuffix(device.DNSName, "."), "online": device.Online, "ip": device.IP})
	case "openwebui_config":
		devices, err := providers.AllDevices(ctx)
		if err != nil {
			return err
		}
		hash, err := hashOpenWebUIConfig(*resource.OpenWebUI, deps.OpenWebUIConnectionsForDevices(ws.Config, devices))
		if err != nil {
			return err
		}
		resource.DesiredHash = hash
		path, err := writeConfig(ctx, ws, providers, resource, opts)
		if err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, path, map[string]any{"path": path})
	case "dashboard_config":
		devices, err := providers.AllDevices(ctx)
		if err != nil {
			return err
		}
		hash, err := hashDashboardConfig(ws, devices)
		if err != nil {
			return err
		}
		resource.DesiredHash = hash
		path, err := writeConfig(ctx, ws, providers, resource, opts)
		if err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, path, map[string]any{"path": path})
	case "control_plane_config":
		hash, err := hashControlPlaneConfig(*resource.ControlPlane)
		if err != nil {
			return err
		}
		resource.DesiredHash = hash
		path, err := writeConfig(ctx, ws, providers, resource, opts)
		if err != nil {
			return err
		}
		return upsertReady(ctx, store, resource, path, map[string]any{"path": path})
	default:
		return nil
	}
}

func deleteResource(ctx context.Context, store *state.Store, providers provider.Set, resource Resource, opts Options) error {
	if resource.Protected && !opts.AllowProtectedDestroy {
		return fmt.Errorf("%s is protected", resource.Address)
	}
	switch resource.Type {
	case "fly_app":
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return err
		}
		if err := flyProvider.DeleteApp(ctx, resourceFlyApp(resource)); err != nil {
			return err
		}
	case "fly_volume":
		if !opts.DestroyData || !opts.BackupFirst {
			return fmt.Errorf("%s requires --destroy-data --backup-first", resource.Address)
		}
		flyProvider, err := providers.FlyFor(resource.ProviderRef)
		if err != nil {
			return err
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

func planSecrets(ctx context.Context, flyProvider provider.FlyRuntime, resource Resource) (Change, error) {
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
	hostname := resourceTailscaleHostname(resource)
	matches := tailscale.FindByHostname(devices, hostname)
	if len(matches) == 0 {
		return Change{Kind: "!", Action: "drift", Address: resource.Address, Class: resource.Class, ProviderRef: resource.ProviderRef, Message: "missing " + hostname, DesiredHash: resource.DesiredHash, Protected: resource.Protected}
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

func writeConfig(ctx context.Context, ws *workspace.Workspace, providers provider.Set, resource Resource, opts Options) (string, error) {
	var data string
	var err error
	switch {
	case resource.Agent != nil:
		data, err = render.AgentFlyTOML(*resource.Agent)
	case resource.Dashboard != nil:
		data, err = render.DashboardFlyTOML(*resource.Dashboard)
	case resource.ControlPlane != nil:
		data, err = render.ControlPlaneFlyTOML(*resource.ControlPlane)
	default:
		devices, tsErr := providers.AllDevices(ctx)
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
	// The dashboard also needs the non-secret fleet topology manifest next to
	// its Fly config so the rollout's Docker build can ship it.
	if resource.Dashboard != nil {
		if err := writeDashboardManifest(ctx, ws, providers, path); err != nil {
			return "", err
		}
	}
	if resource.ControlPlane != nil {
		if err := writeControlPlaneSeed(ws, filepath.Join(filepath.Dir(path), "control-plane-seed")); err != nil {
			return "", err
		}
	}
	return path, nil
}

func writeControlPlaneSeed(ws *workspace.Workspace, seedDir string) error {
	if err := os.RemoveAll(seedDir); err != nil {
		return err
	}
	if err := os.MkdirAll(seedDir, 0o755); err != nil {
		return err
	}
	for _, name := range []string{"companion.toml", "providers.toml", "defaults.toml", "webui.toml", "dashboard.toml", "control-plane.toml"} {
		if err := copyIfExists(filepath.Join(ws.Root, name), filepath.Join(seedDir, name)); err != nil {
			return err
		}
	}
	for _, dir := range []string{"agents", "identities", "vaults"} {
		src := filepath.Join(ws.Root, dir)
		if _, err := os.Stat(src); err == nil {
			if err := copyDir(src, filepath.Join(seedDir, dir)); err != nil {
				return err
			}
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func copyIfExists(src, dst string) error {
	info, err := os.Stat(src)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return copyDir(src, dst)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, data, info.Mode().Perm())
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if entry.Type().IsRegular() {
			return copyIfExists(path, target)
		}
		return nil
	})
}

// writeDashboardManifest builds the live fleet topology and writes fleet.json
// alongside the generated Fly config.
func writeDashboardManifest(ctx context.Context, ws *workspace.Workspace, providers provider.Set, configPath string) error {
	devices, err := providers.AllDevices(ctx)
	if err != nil {
		return err
	}
	topo := status.BuildTopology(ws.Name, ws.Config, devices, dashboardProviderSummary(ws), time.Now())
	data, err := topo.JSON()
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(filepath.Dir(configPath), "fleet.json")
	return os.WriteFile(manifestPath, data, 0o644)
}

// hashDashboardTopology fingerprints the fleet topology (ignoring the generated
// timestamp) so the dashboard redeploys only when the fleet actually changes.
func hashDashboardTopology(ws *workspace.Workspace, devices []tailscale.Device) (string, status.FleetTopology, error) {
	topo := status.BuildTopology(ws.Name, ws.Config, devices, dashboardProviderSummary(ws), time.Time{})
	data, err := topo.JSON()
	if err != nil {
		return "", status.FleetTopology{}, err
	}
	return hashValue(string(data)), topo, nil
}

func hashDashboardConfig(ws *workspace.Workspace, devices []tailscale.Device) (string, error) {
	topologyHash, _, err := hashDashboardTopology(ws, devices)
	if err != nil {
		return "", err
	}
	toml, err := render.DashboardFlyTOML(ws.Config.Dashboard)
	if err != nil {
		return "", err
	}
	return hashMap(map[string]any{
		"fly_toml": toml,
		"topology": topologyHash,
	}), nil
}

func hashControlPlaneConfig(cfg config.ControlPlane) (string, error) {
	toml, err := render.ControlPlaneFlyTOML(cfg)
	if err != nil {
		return "", err
	}
	return hashValue(toml), nil
}

func dashboardProviderSummary(ws *workspace.Workspace) status.ProviderSummary {
	dash := ws.Config.Dashboard
	summary := status.ProviderSummary{}
	if _, name, ok := strings.Cut(dash.Runtime, "."); ok {
		if fp, ok := ws.Providers.Fly[name]; ok {
			summary.FlyOrg = fp.Org
			summary.FlyAPIBaseURL = fp.APIBaseURL
			summary.FlyTokenEnv = fp.TokenEnv
		}
	}
	if _, name, ok := strings.Cut(dash.Network, "."); ok {
		if tp, ok := ws.Providers.Tailscale[name]; ok {
			summary.Tailnet = tp.Tailnet
			summary.TailscaleAPIBaseURL = tp.APIBaseURL
			summary.TailscaleAPIKeyEnv = tp.APIKeyEnv
		}
	}
	return summary
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
	if resource.Dashboard != nil {
		name = "fly." + resource.Dashboard.ID
	}
	if resource.ControlPlane != nil {
		name = "fly." + resource.ControlPlane.ID
	}
	return filepath.Join(dir, name+".toml")
}

func readVolume(ctx context.Context, flyProvider provider.FlyRuntime, resource Resource) (fly.Volume, []fly.Volume, bool, error) {
	volumes, err := flyProvider.ListVolumes(ctx, resourceFlyApp(resource))
	if err != nil {
		return fly.Volume{}, nil, false, err
	}
	selected, matches, ok := fly.SelectVolume(volumes, resourceVolumeName(resource))
	return selected, matches, ok, nil
}

func secretValues(ctx context.Context, ws *workspace.Workspace, providers provider.Set, resource Resource, env map[string]string) (map[string]string, []string, error) {
	required := requiredSecretNames(resource)
	values := map[string]string{}
	missing := []string{}
	if resource.OpenWebUI != nil {
		devices, err := providers.AllDevices(ctx)
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
	if resource.Dashboard != nil {
		return render.RequiredDashboardFlySecrets(*resource.Dashboard)
	}
	if resource.ControlPlane != nil {
		return render.RequiredControlPlaneFlySecrets(*resource.ControlPlane)
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
	if resource.Dashboard != nil {
		return resource.Dashboard.FlyApp
	}
	if resource.ControlPlane != nil {
		return resource.ControlPlane.FlyApp
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
	if resource.ControlPlane != nil {
		return resource.ControlPlane.VolumeName
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
	if resource.ControlPlane != nil {
		return resource.ControlPlane.Region
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
	if resource.ControlPlane != nil {
		return resource.ControlPlane.VolumeSizeGB
	}
	return 1
}

func resourceTailscaleHostname(resource Resource) string {
	if resource.Agent != nil {
		return resource.Agent.TailscaleHostname
	}
	if resource.OpenWebUI != nil {
		return resource.OpenWebUI.TailscaleHostname
	}
	if resource.Dashboard != nil {
		return resource.Dashboard.TailscaleHostname
	}
	if resource.ControlPlane != nil {
		return resource.ControlPlane.TailscaleHostname
	}
	return ""
}

func hydrateAgentIdentity(root string, agent config.Agent) (config.Agent, error) {
	if agent.Identity.Enabled && strings.TrimSpace(agent.Identity.Soul) == "" {
		path := agent.Identity.Path
		if path == "" {
			return agent, fmt.Errorf("agent %s identity requires path or soul", agent.ID)
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, filepath.FromSlash(path))
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return agent, fmt.Errorf("read identity for agent %s: %w", agent.ID, err)
		}
		agent.Identity.Soul = string(data)
	}
	if agent.CompanionSoul.Enabled && strings.TrimSpace(agent.CompanionSoul.Text) == "" {
		path := agent.CompanionSoul.Path
		if path == "" {
			return agent, fmt.Errorf("agent %s companion_soul requires path or text", agent.ID)
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, filepath.FromSlash(path))
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return agent, fmt.Errorf("read companion_soul for agent %s: %w", agent.ID, err)
		}
		agent.CompanionSoul.Text = string(data)
	}
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
