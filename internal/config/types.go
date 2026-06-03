package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

var (
	nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*[a-z0-9]$`)
	envRE  = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
)

type RawConfig struct {
	Defaults  RawDefaults  `toml:"defaults"`
	OpenWebUI RawOpenWebUI `toml:"open_webui"`
	Agents    []RawAgent   `toml:"agents"`
}

type RawDefaults struct {
	Region                     *string         `toml:"region"`
	VolumeName                 *string         `toml:"volume_name"`
	VolumeSizeGB               *int            `toml:"volume_size_gb"`
	Memory                     *string         `toml:"memory"`
	CPUs                       *int            `toml:"cpus"`
	DashboardMode              *string         `toml:"dashboard_mode"`
	DashboardHost              *string         `toml:"dashboard_host"`
	DashboardInsecure          *bool           `toml:"dashboard_insecure"`
	DashboardPort              *int            `toml:"dashboard_port"`
	GraniteEnabled             *bool           `toml:"granite_enabled"`
	TailscaleAuthKeySecretName *string         `toml:"tailscale_authkey_secret_name"`
	TailscaleAcceptDNS         *bool           `toml:"tailscale_accept_dns"`
	TSExtraArgs                *string         `toml:"ts_extra_args"`
	TailscaledExtraArgs        *string         `toml:"tailscaled_extra_args"`
	GraniteTemplate            *string         `toml:"granite_template"`
	Identity                   RawIdentity     `toml:"identity"`
	Model                      RawModel        `toml:"model"`
	APIServer                  RawAPIServer    `toml:"api_server"`
	DefaultVault               RawDefaultVault `toml:"default_vault"`
}

type RawAgent struct {
	ID                         *string              `toml:"id"`
	Runtime                    *string              `toml:"runtime"`
	Network                    *string              `toml:"network"`
	ModelProvider              *string              `toml:"model_provider"`
	Lifecycle                  *string              `toml:"lifecycle"`
	Protect                    *bool                `toml:"protect"`
	FlyApp                     *string              `toml:"fly_app"`
	TailscaleHostname          *string              `toml:"tailscale_hostname"`
	Region                     *string              `toml:"region"`
	VolumeName                 *string              `toml:"volume_name"`
	VolumeSizeGB               *int                 `toml:"volume_size_gb"`
	Memory                     *string              `toml:"memory"`
	CPUs                       *int                 `toml:"cpus"`
	DashboardMode              *string              `toml:"dashboard_mode"`
	DashboardHost              *string              `toml:"dashboard_host"`
	DashboardInsecure          *bool                `toml:"dashboard_insecure"`
	DashboardPort              *int                 `toml:"dashboard_port"`
	GraniteEnabled             *bool                `toml:"granite_enabled"`
	TailscaleAuthKeySecretName *string              `toml:"tailscale_authkey_secret_name"`
	TailscaleAcceptDNS         *bool                `toml:"tailscale_accept_dns"`
	TSExtraArgs                *string              `toml:"ts_extra_args"`
	TailscaledExtraArgs        *string              `toml:"tailscaled_extra_args"`
	GraniteTemplate            *string              `toml:"granite_template"`
	Identity                   RawIdentity          `toml:"identity"`
	Model                      RawModel             `toml:"model"`
	APIServer                  RawAPIServer         `toml:"api_server"`
	DefaultVault               RawDefaultVault      `toml:"default_vault"`
	VaultConnections           []RawVaultConnection `toml:"vault_connections"`
}

type RawIdentity struct {
	Enabled   *bool   `toml:"enabled"`
	Path      *string `toml:"path"`
	Soul      *string `toml:"soul"`
	Overwrite *bool   `toml:"overwrite"`
}

type RawModel struct {
	Enabled          *bool             `toml:"enabled"`
	Provider         *string           `toml:"provider"`
	Default          *string           `toml:"default"`
	Model            *string           `toml:"model"`
	BaseURL          *string           `toml:"base_url"`
	APIKeySecretName *string           `toml:"api_key_secret_name"`
	APIKeyEnv        *string           `toml:"api_key_env"`
	Secrets          map[string]string `toml:"secrets"`
}

type RawAPIServer struct {
	Enabled          *bool   `toml:"enabled"`
	Host             *string `toml:"host"`
	Port             *int    `toml:"port"`
	ModelName        *string `toml:"model_name"`
	KeySecretName    *string `toml:"key_secret_name"`
	CORSOrigins      *string `toml:"cors_origins"`
	OpenWebUIEnabled *bool   `toml:"open_webui_enabled"`
	OpenWebUIHost    *string `toml:"open_webui_host"`
	OpenWebUIURL     *string `toml:"open_webui_url"`
}

type RawDefaultVault struct {
	Enabled      *bool   `toml:"enabled"`
	Path         *string `toml:"path"`
	Name         *string `toml:"name"`
	MCPEnabled   *bool   `toml:"mcp_enabled"`
	MCPName      *string `toml:"mcp_name"`
	MCPRole      *string `toml:"mcp_role"`
	SyncServe    *bool   `toml:"sync_serve"`
	SyncPort     *int    `toml:"sync_port"`
	WriteServe   *bool   `toml:"write_serve"`
	WritePort    *int    `toml:"write_port"`
	SyncInterval *int    `toml:"sync_interval"`
}

type RawVaultConnection struct {
	Name            *string `toml:"name"`
	Mode            *string `toml:"mode"`
	Role            *string `toml:"role"`
	Access          *string `toml:"access"`
	Direction       *string `toml:"direction"`
	MCPRole         *string `toml:"mcp_role"`
	Host            *string `toml:"host"`
	URL             *string `toml:"url"`
	SyncPort        *int    `toml:"sync_port"`
	WritePort       *int    `toml:"write_port"`
	SyncInterval    *int    `toml:"sync_interval"`
	TokenSecretName *string `toml:"token_secret_name"`
	MCPName         *string `toml:"mcp_name"`
	RemoteName      *string `toml:"remote_name"`
	LocalPath       *string `toml:"local_path"`
}

type RawOpenWebUI struct {
	Enabled                    *bool   `toml:"enabled"`
	ID                         *string `toml:"id"`
	Runtime                    *string `toml:"runtime"`
	Network                    *string `toml:"network"`
	Lifecycle                  *string `toml:"lifecycle"`
	Protect                    *bool   `toml:"protect"`
	FlyApp                     *string `toml:"fly_app"`
	TailscaleHostname          *string `toml:"tailscale_hostname"`
	Region                     *string `toml:"region"`
	VolumeName                 *string `toml:"volume_name"`
	VolumeSizeGB               *int    `toml:"volume_size_gb"`
	Memory                     *string `toml:"memory"`
	CPUs                       *int    `toml:"cpus"`
	Port                       *int    `toml:"port"`
	Name                       *string `toml:"name"`
	TailscaleServe             *bool   `toml:"tailscale_serve"`
	TailscaleAcceptDNS         *bool   `toml:"tailscale_accept_dns"`
	TailscaleAuthKeySecretName *string `toml:"tailscale_authkey_secret_name"`
	WebUISecretKeySecretName   *string `toml:"webui_secret_key_secret_name"`
	OpenAIAPIKeysSecretName    *string `toml:"openai_api_keys_secret_name"`
	TSExtraArgs                *string `toml:"ts_extra_args"`
	TailscaledExtraArgs        *string `toml:"tailscaled_extra_args"`
}

type Config struct {
	Defaults  Defaults  `json:"defaults"`
	OpenWebUI OpenWebUI `json:"open_webui"`
	Agents    []Agent   `json:"agents"`
}

type Defaults struct {
	Region                     string       `json:"region"`
	VolumeName                 string       `json:"volume_name"`
	VolumeSizeGB               int          `json:"volume_size_gb"`
	Memory                     string       `json:"memory"`
	CPUs                       int          `json:"cpus"`
	DashboardMode              string       `json:"dashboard_mode"`
	DashboardHost              string       `json:"dashboard_host"`
	DashboardInsecure          bool         `json:"dashboard_insecure"`
	DashboardPort              int          `json:"dashboard_port"`
	GraniteEnabled             bool         `json:"granite_enabled"`
	TailscaleAuthKeySecretName string       `json:"tailscale_authkey_secret_name"`
	TailscaleAcceptDNS         bool         `json:"tailscale_accept_dns"`
	TSExtraArgs                string       `json:"ts_extra_args,omitempty"`
	TailscaledExtraArgs        string       `json:"tailscaled_extra_args,omitempty"`
	GraniteTemplate            string       `json:"granite_template,omitempty"`
	Identity                   Identity     `json:"identity"`
	Model                      Model        `json:"model"`
	APIServer                  APIServer    `json:"api_server"`
	DefaultVault               DefaultVault `json:"default_vault"`
}

type Agent struct {
	ID                         string            `json:"id"`
	Runtime                    string            `json:"runtime"`
	Network                    string            `json:"network"`
	ModelProvider              string            `json:"model_provider"`
	Lifecycle                  string            `json:"lifecycle"`
	Protect                    bool              `json:"protect"`
	FlyApp                     string            `json:"fly_app"`
	TailscaleHostname          string            `json:"tailscale_hostname"`
	Region                     string            `json:"region"`
	VolumeName                 string            `json:"volume_name"`
	VolumeSizeGB               int               `json:"volume_size_gb"`
	Memory                     string            `json:"memory"`
	CPUs                       int               `json:"cpus"`
	DashboardMode              string            `json:"dashboard_mode"`
	DashboardHost              string            `json:"dashboard_host"`
	DashboardInsecure          bool              `json:"dashboard_insecure"`
	DashboardPort              int               `json:"dashboard_port"`
	GraniteEnabled             bool              `json:"granite_enabled"`
	TailscaleAuthKeySecretName string            `json:"tailscale_authkey_secret_name"`
	TailscaleAcceptDNS         bool              `json:"tailscale_accept_dns"`
	TSExtraArgs                string            `json:"ts_extra_args,omitempty"`
	TailscaledExtraArgs        string            `json:"tailscaled_extra_args,omitempty"`
	GraniteTemplate            string            `json:"granite_template,omitempty"`
	Identity                   Identity          `json:"identity"`
	Model                      Model             `json:"model"`
	APIServer                  APIServer         `json:"api_server"`
	DefaultVault               DefaultVault      `json:"default_vault"`
	VaultConnections           []VaultConnection `json:"vault_connections"`
}

type Identity struct {
	Enabled   bool   `json:"enabled"`
	Path      string `json:"path,omitempty"`
	Soul      string `json:"soul,omitempty"`
	Overwrite bool   `json:"overwrite"`
}

type Model struct {
	Enabled          bool              `json:"enabled"`
	Provider         string            `json:"provider,omitempty"`
	Default          string            `json:"default,omitempty"`
	BaseURL          string            `json:"base_url,omitempty"`
	APIKeySecretName string            `json:"api_key_secret_name,omitempty"`
	APIKeyEnv        string            `json:"api_key_env,omitempty"`
	Secrets          map[string]string `json:"secrets,omitempty"`
}

type APIServer struct {
	Enabled          bool   `json:"enabled"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	ModelName        string `json:"model_name"`
	KeySecretName    string `json:"key_secret_name"`
	CORSOrigins      string `json:"cors_origins,omitempty"`
	OpenWebUIEnabled bool   `json:"open_webui_enabled"`
	OpenWebUIHost    string `json:"open_webui_host,omitempty"`
	OpenWebUIURL     string `json:"open_webui_url,omitempty"`
}

type DefaultVault struct {
	Enabled      bool   `json:"enabled"`
	Path         string `json:"path"`
	Name         string `json:"name"`
	MCPEnabled   bool   `json:"mcp_enabled"`
	MCPName      string `json:"mcp_name"`
	MCPRole      string `json:"mcp_role"`
	SyncServe    bool   `json:"sync_serve"`
	SyncPort     int    `json:"sync_port"`
	WriteServe   bool   `json:"write_serve"`
	WritePort    int    `json:"write_port"`
	SyncInterval int    `json:"sync_interval"`
}

type VaultConnection struct {
	Name            string `json:"name"`
	Mode            string `json:"mode"`
	Role            string `json:"role,omitempty"`
	Direction       string `json:"direction,omitempty"`
	MCPRole         string `json:"mcp_role"`
	Host            string `json:"host,omitempty"`
	URL             string `json:"url,omitempty"`
	SyncPort        int    `json:"sync_port,omitempty"`
	WritePort       int    `json:"write_port,omitempty"`
	SyncInterval    int    `json:"sync_interval,omitempty"`
	TokenSecretName string `json:"token_secret_name"`
	MCPName         string `json:"mcp_name"`
	RemoteName      string `json:"remote_name,omitempty"`
	LocalPath       string `json:"local_path,omitempty"`
}

type OpenWebUI struct {
	Enabled                    bool   `json:"enabled"`
	ID                         string `json:"id"`
	Runtime                    string `json:"runtime"`
	Network                    string `json:"network"`
	Lifecycle                  string `json:"lifecycle"`
	Protect                    bool   `json:"protect"`
	FlyApp                     string `json:"fly_app"`
	TailscaleHostname          string `json:"tailscale_hostname"`
	Region                     string `json:"region"`
	VolumeName                 string `json:"volume_name"`
	VolumeSizeGB               int    `json:"volume_size_gb"`
	Memory                     string `json:"memory"`
	CPUs                       int    `json:"cpus"`
	Port                       int    `json:"port"`
	Name                       string `json:"name"`
	TailscaleServe             bool   `json:"tailscale_serve"`
	TailscaleAcceptDNS         bool   `json:"tailscale_accept_dns"`
	TailscaleAuthKeySecretName string `json:"tailscale_authkey_secret_name"`
	WebUISecretKeySecretName   string `json:"webui_secret_key_secret_name"`
	OpenAIAPIKeysSecretName    string `json:"openai_api_keys_secret_name"`
	TSExtraArgs                string `json:"ts_extra_args,omitempty"`
	TailscaledExtraArgs        string `json:"tailscaled_extra_args,omitempty"`
}

type OpenWebUIConnection struct {
	AgentID       string `json:"agent_id"`
	ModelName     string `json:"model_name"`
	URL           string `json:"url"`
	KeySecretName string `json:"key_secret_name"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw RawConfig
	if err := toml.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	cfg, err := Normalize(raw)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

func Normalize(raw RawConfig) (*Config, error) {
	if len(raw.Agents) == 0 {
		return nil, fmt.Errorf("companion.toml must contain at least one [[agents]] entry")
	}

	defaults := normalizeDefaults(raw.Defaults)
	cfg := &Config{
		Defaults:  defaults,
		OpenWebUI: normalizeOpenWebUI(raw.OpenWebUI, defaults),
	}
	for _, rawAgent := range raw.Agents {
		agent, err := normalizeAgent(defaults, rawAgent)
		if err != nil {
			return nil, err
		}
		cfg.Agents = append(cfg.Agents, agent)
	}
	return cfg, cfg.Validate()
}

func (c *Config) Validate() error {
	seen := map[string]bool{}
	for _, agent := range c.Agents {
		if !nameRE.MatchString(agent.ID) {
			return fmt.Errorf("agent id=%q must use lowercase letters, numbers, and hyphens", agent.ID)
		}
		if seen[agent.ID] {
			return fmt.Errorf("duplicate agent id: %s", agent.ID)
		}
		seen[agent.ID] = true
		for key, value := range map[string]string{
			"fly_app":            agent.FlyApp,
			"tailscale_hostname": agent.TailscaleHostname,
		} {
			if !nameRE.MatchString(value) {
				return fmt.Errorf("agent %s %s=%q must use lowercase letters, numbers, and hyphens", agent.ID, key, value)
			}
		}
		if err := validatePort("dashboard_port", agent.DashboardPort); err != nil {
			return fmt.Errorf("agent %s %w", agent.ID, err)
		}
		if agent.DashboardMode != "serve" && agent.DashboardMode != "tailnet-port" && agent.DashboardMode != "off" {
			return fmt.Errorf("agent %s dashboard_mode must be serve, tailnet-port, or off", agent.ID)
		}
		if agent.Lifecycle != "present" && agent.Lifecycle != "absent" {
			return fmt.Errorf("agent %s lifecycle must be present or absent", agent.ID)
		}
		if agent.Runtime == "" || !strings.Contains(agent.Runtime, ".") {
			return fmt.Errorf("agent %s runtime must look like provider.name", agent.ID)
		}
		if agent.Network == "" || !strings.Contains(agent.Network, ".") {
			return fmt.Errorf("agent %s network must look like provider.name", agent.ID)
		}
		if agent.ModelProvider == "" || !strings.Contains(agent.ModelProvider, ".") {
			return fmt.Errorf("agent %s model_provider must look like provider.name", agent.ID)
		}
		if agent.Model.Enabled && agent.Model.Default == "" {
			return fmt.Errorf("agent %s model.default is required when model is enabled", agent.ID)
		}
		if agent.Model.APIKeySecretName != "" && !envRE.MatchString(agent.Model.APIKeySecretName) {
			return fmt.Errorf("agent %s model.api_key_secret_name must be an environment variable name", agent.ID)
		}
		if agent.Model.APIKeyEnv != "" && !envRE.MatchString(agent.Model.APIKeyEnv) {
			return fmt.Errorf("agent %s model.api_key_env must be an environment variable name", agent.ID)
		}
		for envName, secretName := range agent.Model.Secrets {
			if !envRE.MatchString(envName) || !envRE.MatchString(secretName) {
				return fmt.Errorf("agent %s model.secrets must map ENV_NAME to SECRET_NAME", agent.ID)
			}
		}
		if agent.APIServer.Enabled {
			if err := validatePort("api_server.port", agent.APIServer.Port); err != nil {
				return fmt.Errorf("agent %s %w", agent.ID, err)
			}
			if !envRE.MatchString(agent.APIServer.KeySecretName) {
				return fmt.Errorf("agent %s api_server.key_secret_name must be an environment variable name", agent.ID)
			}
		}
		if agent.DefaultVault.MCPRole != "read" && agent.DefaultVault.MCPRole != "write" {
			return fmt.Errorf("agent %s default_vault.mcp_role must be read or write", agent.ID)
		}
		if agent.Identity.Enabled {
			if strings.TrimSpace(agent.Identity.Path) == "" && strings.TrimSpace(agent.Identity.Soul) == "" {
				return fmt.Errorf("agent %s identity requires path or soul when enabled", agent.ID)
			}
			if filepath.IsAbs(agent.Identity.Path) {
				return fmt.Errorf("agent %s identity.path must be relative to the Companion root", agent.ID)
			}
		}
		for _, conn := range agent.VaultConnections {
			if err := validateConnection(agent.ID, conn); err != nil {
				return err
			}
		}
	}
	if c.OpenWebUI.Enabled {
		for key, value := range map[string]string{
			"id":                 c.OpenWebUI.ID,
			"fly_app":            c.OpenWebUI.FlyApp,
			"tailscale_hostname": c.OpenWebUI.TailscaleHostname,
		} {
			if !nameRE.MatchString(value) {
				return fmt.Errorf("open_webui.%s=%q must use lowercase letters, numbers, and hyphens", key, value)
			}
		}
		if err := validatePort("open_webui.port", c.OpenWebUI.Port); err != nil {
			return err
		}
		if c.OpenWebUI.Lifecycle != "present" && c.OpenWebUI.Lifecycle != "absent" {
			return fmt.Errorf("open_webui.lifecycle must be present or absent")
		}
		if c.OpenWebUI.Runtime == "" || !strings.Contains(c.OpenWebUI.Runtime, ".") {
			return fmt.Errorf("open_webui.runtime must look like provider.name")
		}
		if c.OpenWebUI.Network == "" || !strings.Contains(c.OpenWebUI.Network, ".") {
			return fmt.Errorf("open_webui.network must look like provider.name")
		}
		for key, value := range map[string]string{
			"tailscale_authkey_secret_name": c.OpenWebUI.TailscaleAuthKeySecretName,
			"webui_secret_key_secret_name":  c.OpenWebUI.WebUISecretKeySecretName,
			"openai_api_keys_secret_name":   c.OpenWebUI.OpenAIAPIKeysSecretName,
		} {
			if !envRE.MatchString(value) {
				return fmt.Errorf("open_webui.%s must be an environment variable name", key)
			}
		}
	}
	return nil
}

func (c *Config) SelectAgents(ids []string) ([]Agent, error) {
	if len(ids) == 0 {
		return append([]Agent(nil), c.Agents...), nil
	}
	byID := map[string]Agent{}
	for _, agent := range c.Agents {
		byID[agent.ID] = agent
	}
	var selected []Agent
	for _, id := range ids {
		agent, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("unknown agent id: %s", id)
		}
		selected = append(selected, agent)
	}
	return selected, nil
}

func (c *Config) OpenWebUIConnections() []OpenWebUIConnection {
	var connections []OpenWebUIConnection
	for _, agent := range c.Agents {
		api := agent.APIServer
		if !api.Enabled || !api.OpenWebUIEnabled {
			continue
		}
		url := api.OpenWebUIURL
		if url == "" {
			host := api.OpenWebUIHost
			if host == "" {
				host = agent.TailscaleHostname
			}
			url = fmt.Sprintf("http://%s:%d/v1", host, api.Port)
		}
		connections = append(connections, OpenWebUIConnection{
			AgentID:       agent.ID,
			ModelName:     api.ModelName,
			URL:           url,
			KeySecretName: api.KeySecretName,
		})
	}
	return connections
}

func normalizeDefaults(raw RawDefaults) Defaults {
	defaults := Defaults{
		Region:                     stringValue(raw.Region, "cdg"),
		VolumeName:                 stringValue(raw.VolumeName, "data"),
		VolumeSizeGB:               intValue(raw.VolumeSizeGB, 3),
		Memory:                     stringValue(raw.Memory, "4gb"),
		CPUs:                       intValue(raw.CPUs, 2),
		DashboardMode:              stringValue(raw.DashboardMode, "serve"),
		DashboardHost:              stringValue(raw.DashboardHost, ""),
		DashboardInsecure:          boolValue(raw.DashboardInsecure, false),
		DashboardPort:              intValue(raw.DashboardPort, 9119),
		GraniteEnabled:             boolValue(raw.GraniteEnabled, true),
		TailscaleAuthKeySecretName: stringValue(raw.TailscaleAuthKeySecretName, "TS_AUTHKEY"),
		TailscaleAcceptDNS:         boolValue(raw.TailscaleAcceptDNS, false),
		TSExtraArgs:                stringValue(raw.TSExtraArgs, ""),
		TailscaledExtraArgs:        stringValue(raw.TailscaledExtraArgs, ""),
		GraniteTemplate:            stringValue(raw.GraniteTemplate, ""),
	}
	defaults.Model = normalizeModel(nil, raw.Model, "")
	defaults.APIServer = normalizeAPIServer(nil, raw.APIServer, "")
	defaults.DefaultVault = normalizeDefaultVault(nil, raw.DefaultVault, "")
	defaults.Identity = normalizeIdentity(nil, raw.Identity)
	return defaults
}

func normalizeAgent(defaults Defaults, raw RawAgent) (Agent, error) {
	id := stringValue(raw.ID, "")
	if id == "" {
		return Agent{}, fmt.Errorf("agent is missing required key: id")
	}
	agent := Agent{
		ID:                         id,
		Runtime:                    stringValue(raw.Runtime, "fly.default"),
		Network:                    stringValue(raw.Network, "tailscale.default"),
		ModelProvider:              stringValue(raw.ModelProvider, "openrouter.default"),
		Lifecycle:                  stringValue(raw.Lifecycle, "present"),
		Protect:                    boolValue(raw.Protect, true),
		FlyApp:                     stringValue(raw.FlyApp, ""),
		TailscaleHostname:          stringValue(raw.TailscaleHostname, ""),
		Region:                     stringValue(raw.Region, defaults.Region),
		VolumeName:                 stringValue(raw.VolumeName, defaults.VolumeName),
		VolumeSizeGB:               intValue(raw.VolumeSizeGB, defaults.VolumeSizeGB),
		Memory:                     stringValue(raw.Memory, defaults.Memory),
		CPUs:                       intValue(raw.CPUs, defaults.CPUs),
		DashboardMode:              stringValue(raw.DashboardMode, defaults.DashboardMode),
		DashboardHost:              stringValue(raw.DashboardHost, defaults.DashboardHost),
		DashboardInsecure:          boolValue(raw.DashboardInsecure, defaults.DashboardInsecure),
		DashboardPort:              intValue(raw.DashboardPort, defaults.DashboardPort),
		GraniteEnabled:             boolValue(raw.GraniteEnabled, defaults.GraniteEnabled),
		TailscaleAuthKeySecretName: stringValue(raw.TailscaleAuthKeySecretName, defaults.TailscaleAuthKeySecretName),
		TailscaleAcceptDNS:         boolValue(raw.TailscaleAcceptDNS, defaults.TailscaleAcceptDNS),
		TSExtraArgs:                stringValue(raw.TSExtraArgs, defaults.TSExtraArgs),
		TailscaledExtraArgs:        stringValue(raw.TailscaledExtraArgs, defaults.TailscaledExtraArgs),
		GraniteTemplate:            stringValue(raw.GraniteTemplate, defaults.GraniteTemplate),
	}
	if agent.FlyApp == "" {
		return Agent{}, fmt.Errorf("agent %s is missing required key: fly_app", id)
	}
	if agent.TailscaleHostname == "" {
		return Agent{}, fmt.Errorf("agent %s is missing required key: tailscale_hostname", id)
	}
	agent.Model = normalizeModel(&defaults.Model, raw.Model, id)
	agent.APIServer = normalizeAPIServer(&defaults.APIServer, raw.APIServer, id)
	agent.DefaultVault = normalizeDefaultVault(&defaults.DefaultVault, raw.DefaultVault, id)
	agent.Identity = normalizeIdentity(&defaults.Identity, raw.Identity)
	agent.VaultConnections = normalizeVaultConnections(raw.VaultConnections)
	return agent, nil
}

func normalizeIdentity(base *Identity, raw RawIdentity) Identity {
	identity := Identity{Enabled: false, Overwrite: true}
	if base != nil {
		identity = *base
	}
	if base == nil && !rawIdentitySet(raw) {
		return identity
	}
	enabledFallback := identity.Enabled
	if rawIdentitySet(raw) && raw.Enabled == nil {
		enabledFallback = true
	}
	identity.Enabled = boolValue(raw.Enabled, enabledFallback)
	identity.Path = stringValue(raw.Path, identity.Path)
	identity.Soul = stringValue(raw.Soul, identity.Soul)
	identity.Overwrite = boolValue(raw.Overwrite, identity.Overwrite)
	return identity
}

func normalizeModel(base *Model, raw RawModel, _ string) Model {
	model := Model{Enabled: false, Secrets: map[string]string{}}
	if base != nil {
		model = *base
		model.Secrets = copyMap(base.Secrets)
	}
	if raw.Model != nil && raw.Default == nil {
		raw.Default = raw.Model
	}
	if base == nil && !rawModelSet(raw) {
		return model
	}
	model.Enabled = boolValue(raw.Enabled, trueOr(model.Enabled, base != nil))
	model.Provider = stringValue(raw.Provider, model.Provider)
	model.Default = stringValue(raw.Default, model.Default)
	model.BaseURL = stringValue(raw.BaseURL, model.BaseURL)
	model.APIKeySecretName = stringValue(raw.APIKeySecretName, model.APIKeySecretName)
	model.APIKeyEnv = stringValue(raw.APIKeyEnv, model.APIKeyEnv)
	if raw.Secrets != nil {
		model.Secrets = copyMap(raw.Secrets)
	}
	return model
}

func normalizeAPIServer(base *APIServer, raw RawAPIServer, agentID string) APIServer {
	api := APIServer{Enabled: false}
	if base != nil {
		api = *base
	}
	if base == nil && !rawAPIServerSet(raw) {
		return api
	}
	api.Enabled = boolValue(raw.Enabled, trueOr(api.Enabled, base != nil))
	api.Host = stringValue(raw.Host, defaultString(api.Host, "127.0.0.1"))
	api.Port = intValue(raw.Port, defaultInt(api.Port, 8642))
	api.ModelName = stringValue(raw.ModelName, defaultString(api.ModelName, agentID))
	api.KeySecretName = stringValue(raw.KeySecretName, defaultString(api.KeySecretName, "API_SERVER_KEY"))
	api.CORSOrigins = stringValue(raw.CORSOrigins, api.CORSOrigins)
	api.OpenWebUIEnabled = boolValue(raw.OpenWebUIEnabled, trueOr(api.OpenWebUIEnabled, base != nil))
	api.OpenWebUIHost = stringValue(raw.OpenWebUIHost, api.OpenWebUIHost)
	api.OpenWebUIURL = stringValue(raw.OpenWebUIURL, api.OpenWebUIURL)
	return api
}

func normalizeDefaultVault(base *DefaultVault, raw RawDefaultVault, agentID string) DefaultVault {
	vault := DefaultVault{
		Enabled:      true,
		Path:         "/opt/data/.granite",
		Name:         titleFromID(agentID),
		MCPEnabled:   true,
		MCPName:      "granite",
		MCPRole:      "write",
		SyncServe:    true,
		SyncPort:     8765,
		WriteServe:   true,
		WritePort:    3321,
		SyncInterval: 30,
	}
	if base != nil {
		vault = *base
		if raw.Name == nil && agentID != "" && vault.Name == "" {
			vault.Name = titleFromID(agentID)
		}
	}
	vault.Enabled = boolValue(raw.Enabled, vault.Enabled)
	vault.Path = stringValue(raw.Path, vault.Path)
	vault.Name = stringValue(raw.Name, defaultString(vault.Name, titleFromID(agentID)))
	vault.MCPEnabled = boolValue(raw.MCPEnabled, vault.MCPEnabled)
	vault.MCPName = stringValue(raw.MCPName, vault.MCPName)
	vault.MCPRole = stringValue(raw.MCPRole, vault.MCPRole)
	vault.SyncServe = boolValue(raw.SyncServe, vault.SyncServe)
	vault.SyncPort = intValue(raw.SyncPort, vault.SyncPort)
	vault.WriteServe = boolValue(raw.WriteServe, vault.WriteServe)
	vault.WritePort = intValue(raw.WritePort, vault.WritePort)
	vault.SyncInterval = intValue(raw.SyncInterval, vault.SyncInterval)
	return vault
}

func normalizeVaultConnections(raw []RawVaultConnection) []VaultConnection {
	var connections []VaultConnection
	for _, item := range raw {
		name := stringValue(item.Name, "")
		mode := stringValue(item.Mode, "")
		conn := VaultConnection{
			Name:            name,
			Mode:            mode,
			Host:            stringValue(item.Host, ""),
			URL:             stringValue(item.URL, ""),
			TokenSecretName: stringValue(item.TokenSecretName, fmt.Sprintf("GRANITE_%s_TOKEN", strings.ToUpper(strings.ReplaceAll(name, "-", "_")))),
			MCPName:         stringValue(item.MCPName, "granite_"+strings.ReplaceAll(name, "-", "_")),
		}
		if mode == "sync" {
			role := stringValue(item.Role, stringValue(item.Access, "read"))
			conn.Role = role
			conn.Direction = stringValue(item.Direction, mapRoleDirection(role))
			conn.MCPRole = stringValue(item.MCPRole, role)
			conn.SyncPort = intValue(item.SyncPort, 8765)
			conn.SyncInterval = intValue(item.SyncInterval, 30)
			conn.RemoteName = stringValue(item.RemoteName, name)
			conn.LocalPath = stringValue(item.LocalPath, "/opt/data/vaults/"+name)
		} else {
			conn.MCPRole = stringValue(item.MCPRole, "write")
			conn.WritePort = intValue(item.WritePort, 3321)
		}
		connections = append(connections, conn)
	}
	return connections
}

func normalizeOpenWebUI(raw RawOpenWebUI, defaults Defaults) OpenWebUI {
	if !rawOpenWebUISet(raw) {
		return OpenWebUI{Enabled: false}
	}
	return OpenWebUI{
		Enabled:                    boolValue(raw.Enabled, false),
		ID:                         stringValue(raw.ID, "open-webui"),
		Runtime:                    stringValue(raw.Runtime, "fly.default"),
		Network:                    stringValue(raw.Network, "tailscale.default"),
		Lifecycle:                  stringValue(raw.Lifecycle, "present"),
		Protect:                    boolValue(raw.Protect, true),
		FlyApp:                     stringValue(raw.FlyApp, "example-companion-webui"),
		TailscaleHostname:          stringValue(raw.TailscaleHostname, "companion-webui"),
		Region:                     stringValue(raw.Region, defaults.Region),
		VolumeName:                 stringValue(raw.VolumeName, "open_webui_data"),
		VolumeSizeGB:               intValue(raw.VolumeSizeGB, 5),
		Memory:                     stringValue(raw.Memory, "4gb"),
		CPUs:                       intValue(raw.CPUs, 2),
		Port:                       intValue(raw.Port, 8080),
		Name:                       stringValue(raw.Name, "Companion"),
		TailscaleServe:             boolValue(raw.TailscaleServe, true),
		TailscaleAcceptDNS:         boolValue(raw.TailscaleAcceptDNS, true),
		TailscaleAuthKeySecretName: stringValue(raw.TailscaleAuthKeySecretName, defaults.TailscaleAuthKeySecretName),
		WebUISecretKeySecretName:   stringValue(raw.WebUISecretKeySecretName, "WEBUI_SECRET_KEY"),
		OpenAIAPIKeysSecretName:    stringValue(raw.OpenAIAPIKeysSecretName, "OPENAI_API_KEYS"),
		TSExtraArgs:                stringValue(raw.TSExtraArgs, defaults.TSExtraArgs),
		TailscaledExtraArgs:        stringValue(raw.TailscaledExtraArgs, ""),
	}
}

func validateConnection(agentID string, conn VaultConnection) error {
	if conn.Name == "" || !nameRE.MatchString(conn.Name) {
		return fmt.Errorf("agent %s has invalid vault connection name: %q", agentID, conn.Name)
	}
	if conn.Mode != "write" && conn.Mode != "sync" {
		return fmt.Errorf("agent %s vault connection %q mode must be write or sync", agentID, conn.Name)
	}
	if conn.Host == "" && conn.URL == "" {
		return fmt.Errorf("agent %s vault connection %q requires host or url", agentID, conn.Name)
	}
	if !envRE.MatchString(conn.TokenSecretName) {
		return fmt.Errorf("agent %s vault connection %q token_secret_name must be an environment variable name", agentID, conn.Name)
	}
	if conn.Mode == "sync" {
		if conn.Role != "read" && conn.Role != "write" {
			return fmt.Errorf("agent %s vault connection %q role must be read or write", agentID, conn.Name)
		}
		if conn.Direction != "pull" && conn.Direction != "run" {
			return fmt.Errorf("agent %s vault connection %q direction must be pull or run", agentID, conn.Name)
		}
		if conn.Role == "read" && conn.Direction != "pull" {
			return fmt.Errorf("agent %s vault connection %q cannot use direction=%q with role=read", agentID, conn.Name, conn.Direction)
		}
		if conn.Role == "read" && conn.MCPRole == "write" {
			return fmt.Errorf("agent %s vault connection %q cannot expose write MCP for a read sync grant", agentID, conn.Name)
		}
	}
	if conn.MCPRole != "read" && conn.MCPRole != "write" {
		return fmt.Errorf("agent %s vault connection %q mcp_role must be read or write", agentID, conn.Name)
	}
	return nil
}

func validatePort(name string, port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("%s must be between 1 and 65535", name)
	}
	return nil
}

func stringValue(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func boolValue(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func intValue(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func defaultInt(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

func trueOr(value bool, condition bool) bool {
	if condition {
		return value
	}
	return true
}

func copyMap(input map[string]string) map[string]string {
	output := map[string]string{}
	for key, value := range input {
		output[key] = value
	}
	return output
}

func titleFromID(agentID string) string {
	if agentID == "" {
		return "Companion"
	}
	parts := strings.Split(agentID, "-")
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return "Companion " + strings.Join(parts, " ")
}

func mapRoleDirection(role string) string {
	if role == "read" {
		return "pull"
	}
	return "run"
}

func rawModelSet(raw RawModel) bool {
	return raw.Enabled != nil || raw.Provider != nil || raw.Default != nil || raw.Model != nil || raw.BaseURL != nil || raw.APIKeySecretName != nil || raw.APIKeyEnv != nil || raw.Secrets != nil
}

func rawAPIServerSet(raw RawAPIServer) bool {
	return raw.Enabled != nil || raw.Host != nil || raw.Port != nil || raw.ModelName != nil || raw.KeySecretName != nil || raw.CORSOrigins != nil || raw.OpenWebUIEnabled != nil || raw.OpenWebUIHost != nil || raw.OpenWebUIURL != nil
}

func rawIdentitySet(raw RawIdentity) bool {
	return raw.Enabled != nil || raw.Path != nil || raw.Soul != nil || raw.Overwrite != nil
}

func rawOpenWebUISet(raw RawOpenWebUI) bool {
	return raw.Enabled != nil || raw.ID != nil || raw.FlyApp != nil || raw.TailscaleHostname != nil || raw.Region != nil || raw.VolumeName != nil || raw.VolumeSizeGB != nil || raw.Memory != nil || raw.CPUs != nil || raw.Port != nil || raw.Name != nil || raw.TailscaleServe != nil || raw.TailscaleAcceptDNS != nil || raw.TailscaleAuthKeySecretName != nil || raw.WebUISecretKeySecretName != nil || raw.OpenAIAPIKeysSecretName != nil || raw.TSExtraArgs != nil || raw.TailscaledExtraArgs != nil
}
