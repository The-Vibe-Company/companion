package outputs

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/deps"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

type FlyReader interface {
	ListMachines(ctx context.Context, app string) ([]fly.Machine, error)
}

type TailscaleReader interface {
	Devices(ctx context.Context) ([]tailscale.Device, error)
}

type Fleet struct {
	AgentIDValues     []string         `json:"agent_ids"`
	Agents            map[string]Agent `json:"agents"`
	OpenWebUI         *OpenWebUI       `json:"open_webui,omitempty"`
	OpenWebUIURL      string           `json:"open_webui_url,omitempty"`
	OpenWebUIBackends []Backend        `json:"open_webui_backends,omitempty"`
}

type Agent struct {
	ID                string            `json:"id"`
	FlyApp            string            `json:"fly_app"`
	FlyMachineID      string            `json:"fly_machine_id"`
	FlyMachineState   string            `json:"fly_machine_state"`
	Region            string            `json:"region"`
	TailscaleHostname string            `json:"tailscale_hostname"`
	TailscaleDNS      string            `json:"tailscale_dns"`
	TailscaleIP       string            `json:"tailscale_ip"`
	DashboardURL      string            `json:"dashboard_url"`
	APIBaseURL        string            `json:"api_base_url"`
	APIHealthURL      string            `json:"api_health_url"`
	OpenAIBaseURL     string            `json:"openai_base_url"`
	ModelName         string            `json:"model_name"`
	Model             string            `json:"model"`
	DefaultVault      Vault             `json:"default_vault"`
	VaultConnections  []VaultConnection `json:"vault_connections,omitempty"`
}

type Vault struct {
	Enabled      bool   `json:"enabled"`
	Name         string `json:"name"`
	Path         string `json:"path"`
	MCPName      string `json:"mcp_name"`
	MCPRole      string `json:"mcp_role"`
	SyncURL      string `json:"sync_url"`
	WriteMCPURL  string `json:"write_mcp_url"`
	SyncInterval int    `json:"sync_interval,omitempty"`
}

type VaultConnection struct {
	Name            string `json:"name"`
	Mode            string `json:"mode"`
	Role            string `json:"role,omitempty"`
	Direction       string `json:"direction,omitempty"`
	Host            string `json:"host,omitempty"`
	URL             string `json:"url,omitempty"`
	SyncURL         string `json:"sync_url,omitempty"`
	WriteMCPURL     string `json:"write_mcp_url,omitempty"`
	MCPName         string `json:"mcp_name,omitempty"`
	MCPRole         string `json:"mcp_role,omitempty"`
	TokenSecretName string `json:"token_secret_name,omitempty"`
}

type OpenWebUI struct {
	Enabled           bool      `json:"enabled"`
	FlyApp            string    `json:"fly_app"`
	FlyMachineID      string    `json:"fly_machine_id"`
	FlyMachineState   string    `json:"fly_machine_state"`
	TailscaleHostname string    `json:"tailscale_hostname"`
	TailscaleDNS      string    `json:"tailscale_dns"`
	TailscaleIP       string    `json:"tailscale_ip"`
	URL               string    `json:"url"`
	Backends          []Backend `json:"backends"`
}

type Backend struct {
	AgentID       string `json:"agent_id"`
	ModelName     string `json:"model_name"`
	URL           string `json:"url"`
	KeySecretName string `json:"key_secret_name"`
}

func Build(ctx context.Context, cfg *config.Config, flyProvider FlyReader, tsProvider TailscaleReader) Fleet {
	devices, _ := tsProvider.Devices(ctx)
	fleet := Fleet{
		Agents: map[string]Agent{},
	}
	for _, agent := range cfg.Agents {
		fleet.AgentIDValues = append(fleet.AgentIDValues, agent.ID)
		fleet.Agents[agent.ID] = buildAgent(ctx, agent, devices, flyProvider)
	}
	sort.Strings(fleet.AgentIDValues)
	if cfg.OpenWebUI.Enabled {
		openWebUI := buildOpenWebUI(ctx, cfg.OpenWebUI, deps.OpenWebUIConnections(ctx, cfg, tsProvider), devices, flyProvider)
		fleet.OpenWebUI = &openWebUI
		fleet.OpenWebUIURL = openWebUI.URL
		fleet.OpenWebUIBackends = openWebUI.Backends
	}
	return fleet
}

func buildAgent(ctx context.Context, agent config.Agent, devices []tailscale.Device, flyProvider FlyReader) Agent {
	host, device := resolvedHost(devices, agent.TailscaleHostname)
	output := Agent{
		ID:                agent.ID,
		FlyApp:            agent.FlyApp,
		Region:            agent.Region,
		TailscaleHostname: agent.TailscaleHostname,
		TailscaleDNS:      host,
		TailscaleIP:       device.IP,
		ModelName:         agent.APIServer.ModelName,
		Model:             agent.Model.Default,
		DefaultVault:      buildVault(agent, host),
		VaultConnections:  buildVaultConnections(agent.VaultConnections),
	}
	if machine, ok := selectedMachine(ctx, flyProvider, agent.FlyApp); ok {
		output.FlyMachineID = machine.ID
		output.FlyMachineState = machine.State
	}
	if agent.DashboardMode == "serve" && host != "" {
		output.DashboardURL = "https://" + host + "/"
	} else if agent.DashboardMode == "tailnet-port" && host != "" {
		output.DashboardURL = fmt.Sprintf("http://%s:%d", host, agent.DashboardPort)
	}
	if agent.APIServer.Enabled {
		output.APIBaseURL = agentAPIBaseURL(agent, devices, host)
		if output.APIBaseURL != "" {
			output.APIHealthURL = output.APIBaseURL + "/health"
			output.OpenAIBaseURL = output.APIBaseURL + "/v1"
		}
	}
	return output
}

func buildVault(agent config.Agent, host string) Vault {
	vault := agent.DefaultVault
	output := Vault{
		Enabled:      agent.GraniteEnabled && vault.Enabled,
		Name:         vault.Name,
		Path:         vault.Path,
		MCPName:      vault.MCPName,
		MCPRole:      vault.MCPRole,
		SyncInterval: vault.SyncInterval,
	}
	if !output.Enabled || host == "" {
		return output
	}
	if vault.SyncServe {
		output.SyncURL = fmt.Sprintf("http://%s:%d/sync", host, vault.SyncPort)
	}
	if vault.WriteServe {
		output.WriteMCPURL = fmt.Sprintf("http://%s:%d/mcp", host, vault.WritePort)
	}
	return output
}

func buildVaultConnections(connections []config.VaultConnection) []VaultConnection {
	output := make([]VaultConnection, 0, len(connections))
	for _, connection := range connections {
		item := VaultConnection{
			Name:            connection.Name,
			Mode:            connection.Mode,
			Role:            connection.Role,
			Direction:       connection.Direction,
			Host:            connection.Host,
			URL:             connection.URL,
			MCPName:         connection.MCPName,
			MCPRole:         connection.MCPRole,
			TokenSecretName: connection.TokenSecretName,
		}
		if connection.URL != "" {
			item.SyncURL = strings.TrimRight(connection.URL, "/")
			item.WriteMCPURL = strings.TrimRight(connection.URL, "/")
		} else if connection.Host != "" {
			if connection.SyncPort > 0 {
				item.SyncURL = fmt.Sprintf("http://%s:%d/sync", connection.Host, connection.SyncPort)
			}
			if connection.WritePort > 0 {
				item.WriteMCPURL = fmt.Sprintf("http://%s:%d/mcp", connection.Host, connection.WritePort)
			}
		}
		output = append(output, item)
	}
	return output
}

func buildOpenWebUI(ctx context.Context, cfg config.OpenWebUI, connections []config.OpenWebUIConnection, devices []tailscale.Device, flyProvider FlyReader) OpenWebUI {
	host, device := resolvedHost(devices, cfg.TailscaleHostname)
	output := OpenWebUI{
		Enabled:           cfg.Enabled,
		FlyApp:            cfg.FlyApp,
		TailscaleHostname: cfg.TailscaleHostname,
		TailscaleDNS:      host,
		TailscaleIP:       device.IP,
		Backends:          buildBackends(connections),
	}
	if machine, ok := selectedMachine(ctx, flyProvider, cfg.FlyApp); ok {
		output.FlyMachineID = machine.ID
		output.FlyMachineState = machine.State
	}
	if cfg.TailscaleServe && host != "" {
		output.URL = "https://" + host + "/"
	} else if host != "" {
		output.URL = fmt.Sprintf("http://%s:%d", host, cfg.Port)
	}
	return output
}

func buildBackends(connections []config.OpenWebUIConnection) []Backend {
	backends := make([]Backend, 0, len(connections))
	for _, connection := range connections {
		backends = append(backends, Backend{
			AgentID:       connection.AgentID,
			ModelName:     connection.ModelName,
			URL:           connection.URL,
			KeySecretName: connection.KeySecretName,
		})
	}
	return backends
}

func selectedMachine(ctx context.Context, provider FlyReader, app string) (fly.Machine, bool) {
	machines, err := provider.ListMachines(ctx, app)
	if err != nil {
		return fly.Machine{}, false
	}
	return fly.SelectStartedMachine(machines)
}

func resolvedHost(devices []tailscale.Device, hostname string) (string, tailscale.Device) {
	dnsName := deps.TailscaleDNSName(devices, hostname)
	for _, device := range tailscale.FindByHostname(devices, hostname) {
		if strings.TrimSuffix(device.DNSName, ".") == dnsName {
			return dnsName, device
		}
	}
	if dnsName != "" {
		return dnsName, tailscale.Device{}
	}
	return "", tailscale.Device{}
}

func agentAPIBaseURL(agent config.Agent, devices []tailscale.Device, host string) string {
	if agent.APIServer.OpenWebUIURL != "" {
		return deps.AgentAPIBaseURL(agent, devices)
	}
	if host == "" {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", host, agent.APIServer.Port)
}

func Text(fleet Fleet) string {
	lines := []string{}
	if len(fleet.AgentIDValues) > 0 {
		lines = append(lines, "agent_ids = "+quoteList(fleet.AgentIDValues))
	}
	if fleet.OpenWebUIURL != "" {
		lines = append(lines, "open_webui_url = "+strconv.Quote(fleet.OpenWebUIURL))
	}
	if len(fleet.OpenWebUIBackends) > 0 {
		ids := make([]string, 0, len(fleet.OpenWebUIBackends))
		for _, backend := range fleet.OpenWebUIBackends {
			ids = append(ids, backend.AgentID)
		}
		lines = append(lines, "open_webui_backends = "+quoteList(ids))
	}
	lines = append(lines, "agents = {")
	agentIDs := sortedAgentIDs(fleet.Agents)
	for _, id := range agentIDs {
		agent := fleet.Agents[id]
		lines = append(lines, "  "+id+" = {")
		appendTextField(&lines, "    ", "fly_app", agent.FlyApp)
		appendTextField(&lines, "    ", "fly_machine_id", agent.FlyMachineID)
		appendTextField(&lines, "    ", "fly_machine_state", agent.FlyMachineState)
		appendTextField(&lines, "    ", "tailscale_dns", agent.TailscaleDNS)
		appendTextField(&lines, "    ", "dashboard_url", agent.DashboardURL)
		appendTextField(&lines, "    ", "api_base_url", agent.APIBaseURL)
		appendTextField(&lines, "    ", "openai_base_url", agent.OpenAIBaseURL)
		appendTextField(&lines, "    ", "granite_sync_url", agent.DefaultVault.SyncURL)
		appendTextField(&lines, "    ", "granite_mcp_url", agent.DefaultVault.WriteMCPURL)
		lines = append(lines, "  }")
	}
	lines = append(lines, "}")
	return strings.Join(lines, "\n")
}

func Lookup(root any, path string) (any, error) {
	if strings.TrimSpace(path) == "" {
		return root, nil
	}
	data, err := json.Marshal(root)
	if err != nil {
		return nil, err
	}
	var current any
	if err := json.Unmarshal(data, &current); err != nil {
		return nil, err
	}
	for _, part := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("output %q cannot be traversed at %q", path, part)
		}
		next, ok := object[part]
		if !ok {
			return nil, fmt.Errorf("unknown output: %s", path)
		}
		current = next
	}
	return current, nil
}

func RawString(value any) (string, error) {
	switch typed := value.(type) {
	case string:
		return typed, nil
	case bool:
		return strconv.FormatBool(typed), nil
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64), nil
	case nil:
		return "", nil
	default:
		return "", fmt.Errorf("--raw requires a scalar output")
	}
}

func JSON(value any) ([]byte, error) {
	return json.MarshalIndent(value, "", "  ")
}

func sortedAgentIDs(agents map[string]Agent) []string {
	ids := make([]string, 0, len(agents))
	for id := range agents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func appendTextField(lines *[]string, prefix, key, value string) {
	if value == "" {
		return
	}
	*lines = append(*lines, prefix+key+" = "+strconv.Quote(value))
}

func quoteList(values []string) string {
	quoted := make([]string, len(values))
	for i, value := range values {
		quoted[i] = strconv.Quote(value)
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}
