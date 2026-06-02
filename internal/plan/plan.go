package plan

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/deps"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

type Action struct {
	Kind    string `json:"kind"`
	Subject string `json:"subject"`
	Message string `json:"message"`
}

type Report struct {
	Actions []Action `json:"actions"`
}

func (r Report) String() string {
	if len(r.Actions) == 0 {
		return "= no-op"
	}
	var lines []string
	for _, action := range r.Actions {
		lines = append(lines, fmt.Sprintf("%s %s %s", action.Kind, action.Subject, action.Message))
	}
	return strings.Join(lines, "\n")
}

func Build(ctx context.Context, cfg *config.Config, agents []config.Agent, flyProvider fly.Provider, tsProvider tailscale.Provider) Report {
	var actions []Action
	for _, agent := range agents {
		exists, _ := flyProvider.AppExists(ctx, agent.FlyApp)
		if exists {
			actions = append(actions, Action{Kind: "=", Subject: "no-op", Message: "fly app " + agent.FlyApp})
		} else {
			actions = append(actions, Action{Kind: "+", Subject: "create", Message: "fly app " + agent.FlyApp})
		}
		volumes, _ := flyProvider.ListVolumes(ctx, agent.FlyApp)
		selected, matches, ok := fly.SelectVolume(volumes, agent.VolumeName)
		if !ok {
			actions = append(actions, Action{Kind: "+", Subject: "create", Message: fmt.Sprintf("volume %s", agent.VolumeName)})
		} else if len(matches) > 1 {
			actions = append(actions, Action{Kind: "!", Subject: "drift", Message: fmt.Sprintf("duplicate volume %s reused %s", agent.VolumeName, selected.ID)})
		} else if selected.SizeGB < agent.VolumeSizeGB {
			actions = append(actions, Action{Kind: "~", Subject: "update", Message: fmt.Sprintf("volume %s %dGB -> %dGB", agent.VolumeName, selected.SizeGB, agent.VolumeSizeGB)})
		} else {
			actions = append(actions, Action{Kind: "=", Subject: "no-op", Message: fmt.Sprintf("volume %s %s", agent.VolumeName, selected.ID)})
		}
	}
	if cfg.OpenWebUI.Enabled && len(agents) == len(cfg.Agents) {
		connections := deps.OpenWebUIConnections(ctx, cfg, tsProvider)
		ids := make([]string, 0, len(connections))
		baseURLs := make([]string, 0, len(connections))
		for _, connection := range connections {
			ids = append(ids, connection.AgentID)
			baseURLs = append(baseURLs, connection.URL)
		}
		desired := strings.Join(baseURLs, ";")
		observed := ""
		if machines, err := flyProvider.ListMachines(ctx, cfg.OpenWebUI.FlyApp); err == nil {
			observed = openWebUIBaseURLs(machines)
		}
		if observed == desired {
			actions = append(actions, Action{Kind: "=", Subject: "no-op", Message: "open-webui backends " + strings.Join(ids, ",")})
		} else {
			actions = append(actions, Action{Kind: "~", Subject: "update", Message: "open-webui backends " + strings.Join(ids, ",")})
		}
	}
	if devices, err := tsProvider.Devices(ctx); err == nil && len(devices) > 0 {
		for _, agent := range agents {
			matches := tailscale.FindByHostname(devices, agent.TailscaleHostname)
			if len(matches) == 0 {
				actions = append(actions, Action{Kind: "!", Subject: "drift", Message: "tailscale hostname missing " + agent.TailscaleHostname})
			}
		}
	}
	return Report{Actions: actions}
}

func openWebUIBaseURLs(machines []fly.Machine) string {
	for _, machine := range machines {
		if machine.State == "started" && machine.Config.Env["OPENAI_API_BASE_URLS"] != "" {
			return machine.Config.Env["OPENAI_API_BASE_URLS"]
		}
	}
	for _, machine := range machines {
		if machine.Config.Env["OPENAI_API_BASE_URLS"] != "" {
			return machine.Config.Env["OPENAI_API_BASE_URLS"]
		}
	}
	return ""
}

func Drift(ctx context.Context, cfg *config.Config, flyProvider fly.Provider, tsProvider tailscale.Provider) Report {
	var actions []Action
	for _, agent := range cfg.Agents {
		volumes, _ := flyProvider.ListVolumes(ctx, agent.FlyApp)
		selected, matches, ok := fly.SelectVolume(volumes, agent.VolumeName)
		if ok && len(matches) > 1 {
			actions = append(actions, Action{Kind: "!", Subject: "drift", Message: fmt.Sprintf("duplicate volume %s reused %s", agent.VolumeName, selected.ID)})
		}
		if strings.Contains(agent.APIServer.OpenWebUIHost, agent.TailscaleHostname+"-") {
			actions = append(actions, Action{Kind: "!", Subject: "drift", Message: fmt.Sprintf("tailscale hostname %s actual %s", agent.TailscaleHostname, agent.APIServer.OpenWebUIHost)})
		}
	}
	if devices, err := tsProvider.Devices(ctx); err == nil && len(devices) > 0 {
		for _, agent := range cfg.Agents {
			matches := tailscale.FindByHostname(devices, agent.TailscaleHostname)
			if len(matches) > 1 {
				actions = append(actions, Action{Kind: "!", Subject: "drift", Message: "multiple tailscale devices for " + agent.TailscaleHostname})
			}
		}
	}
	return Report{Actions: actions}
}

type Graph struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

type GraphNode struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

type GraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Mode string `json:"mode"`
	Role string `json:"role,omitempty"`
}

func BuildGraph(cfg *config.Config) Graph {
	graph := Graph{}
	for _, agent := range cfg.Agents {
		graph.Nodes = append(graph.Nodes, GraphNode{ID: agent.ID, Kind: "agent"})
		if agent.DefaultVault.Enabled {
			vaultID := agent.ID + ":default-vault"
			graph.Nodes = append(graph.Nodes, GraphNode{ID: vaultID, Kind: "vault"})
			graph.Edges = append(graph.Edges, GraphEdge{From: agent.ID, To: vaultID, Mode: "owns", Role: agent.DefaultVault.MCPRole})
		}
		for _, connection := range agent.VaultConnections {
			graph.Edges = append(graph.Edges, GraphEdge{From: agent.ID, To: connection.Name, Mode: connection.Mode, Role: connection.Role})
		}
	}
	return graph
}

func (g Graph) Text() string {
	var lines []string
	for _, edge := range g.Edges {
		role := edge.Role
		if role != "" {
			role = " role=" + role
		}
		lines = append(lines, fmt.Sprintf("%s -> %s [%s%s]", edge.From, edge.To, edge.Mode, role))
	}
	if len(lines) == 0 {
		return "(empty graph)"
	}
	return strings.Join(lines, "\n")
}

func (g Graph) JSON() ([]byte, error) {
	return json.MarshalIndent(g, "", "  ")
}
