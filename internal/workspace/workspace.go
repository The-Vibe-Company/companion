package workspace

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/The-Vibe-Company/companion/internal/config"
)

var (
	envNameRE = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
	nameRE    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*[a-z0-9]$`)
)

type Workspace struct {
	Root       string
	Name       string
	StatePath  string
	Config     *config.Config
	Providers  Providers
	AgentFiles map[string]string
	Vaults     []Vault
	VaultFiles map[string]string
}

type Providers struct {
	Fly        map[string]FlyProvider        `toml:"fly"`
	Tailscale  map[string]TailscaleProvider  `toml:"tailscale"`
	OpenRouter map[string]OpenRouterProvider `toml:"openrouter"`
}

type FlyProvider struct {
	Org        string `toml:"org" json:"org"`
	Region     string `toml:"region" json:"region"`
	TokenEnv   string `toml:"token_env" json:"token_env"`
	Mode       string `toml:"mode" json:"mode"`
	APIBaseURL string `toml:"api_base_url" json:"api_base_url"`
}

type TailscaleProvider struct {
	Tailnet       string `toml:"tailnet" json:"tailnet"`
	APIKeyEnv     string `toml:"api_key_env" json:"api_key_env"`
	AuthKeySecret string `toml:"auth_key_secret" json:"auth_key_secret"`
	Mode          string `toml:"mode" json:"mode"`
	APIBaseURL    string `toml:"api_base_url" json:"api_base_url"`
}

type OpenRouterProvider struct {
	BaseURL    string `toml:"base_url" json:"base_url"`
	APIBaseURL string `toml:"api_base_url" json:"api_base_url"`
	APIKeyEnv  string `toml:"api_key_env" json:"api_key_env"`
}

type Vault struct {
	ID        string `json:"id"`
	Lifecycle string `json:"lifecycle"`
}

type rootFile struct {
	Workspace string `toml:"workspace"`
	Backend   struct {
		Local struct {
			State string `toml:"state"`
		} `toml:"local"`
	} `toml:"backend"`
	Load loadConfig `toml:"load"`
}

type loadConfig struct {
	Providers string `toml:"providers"`
	Defaults  string `toml:"defaults"`
	WebUI     string `toml:"webui"`
	Dashboard string `toml:"dashboard"`
	Agents    string `toml:"agents"`
	Vaults    string `toml:"vaults"`
}

type defaultsFile struct {
	Defaults config.RawDefaults `toml:"defaults"`
}

type webUIFile struct {
	OpenWebUI config.RawOpenWebUI `toml:"open_webui"`
}

type dashboardFile struct {
	Dashboard config.RawDashboard `toml:"dashboard"`
}

type agentFile struct {
	Agent            rawAgentTable               `toml:"agent"`
	Model            config.RawModel             `toml:"model"`
	APIServer        config.RawAPIServer         `toml:"api_server"`
	DefaultVault     config.RawDefaultVault      `toml:"default_vault"`
	Identity         config.RawIdentity          `toml:"identity"`
	VaultConnection  []config.RawVaultConnection `toml:"vault_connections"`
	VaultConnections []config.RawVaultConnection `toml:"vault_connection"`
}

type vaultFile struct {
	Vault rawVaultTable `toml:"vault"`
}

type rawVaultTable struct {
	ID        *string `toml:"id"`
	Lifecycle *string `toml:"lifecycle"`
}

type rawAgentTable struct {
	ID                         *string `toml:"id"`
	Runtime                    *string `toml:"runtime"`
	Network                    *string `toml:"network"`
	ModelProvider              *string `toml:"model_provider"`
	Lifecycle                  *string `toml:"lifecycle"`
	Protect                    *bool   `toml:"protect"`
	FlyApp                     *string `toml:"fly_app"`
	TailscaleHostname          *string `toml:"tailscale_hostname"`
	IdentityPath               *string `toml:"identity"`
	Region                     *string `toml:"region"`
	VolumeName                 *string `toml:"volume_name"`
	VolumeSizeGB               *int    `toml:"volume_size_gb"`
	Memory                     *string `toml:"memory"`
	CPUs                       *int    `toml:"cpus"`
	DashboardMode              *string `toml:"dashboard_mode"`
	DashboardHost              *string `toml:"dashboard_host"`
	DashboardInsecure          *bool   `toml:"dashboard_insecure"`
	DashboardPort              *int    `toml:"dashboard_port"`
	GraniteEnabled             *bool   `toml:"granite_enabled"`
	TailscaleAuthKeySecretName *string `toml:"tailscale_authkey_secret_name"`
	TailscaleAcceptDNS         *bool   `toml:"tailscale_accept_dns"`
	TSExtraArgs                *string `toml:"ts_extra_args"`
	TailscaledExtraArgs        *string `toml:"tailscaled_extra_args"`
	GraniteTemplate            *string `toml:"granite_template"`
}

func Load(root string) (*Workspace, error) {
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	rootPath := filepath.Join(absRoot, "companion.toml")
	var rootConfig rootFile
	if err := readTOML(rootPath, &rootConfig); err != nil {
		return nil, err
	}
	rootConfig.defaults(filepath.Base(absRoot))

	providers, err := loadProviders(absRoot, rootConfig.Load.Providers)
	if err != nil {
		return nil, err
	}
	raw := config.RawConfig{}
	if err := loadDefaults(absRoot, rootConfig.Load.Defaults, &raw); err != nil {
		return nil, err
	}
	if err := loadWebUI(absRoot, rootConfig.Load.WebUI, &raw); err != nil {
		return nil, err
	}
	if err := loadDashboard(absRoot, rootConfig.Load.Dashboard, &raw); err != nil {
		return nil, err
	}
	agentFiles, err := loadAgents(absRoot, rootConfig.Load.Agents, &raw)
	if err != nil {
		return nil, err
	}
	vaults, vaultFiles, err := loadVaults(absRoot, rootConfig.Load.Vaults)
	if err != nil {
		return nil, err
	}
	applyLegacyTailscaleDefault(&raw, providers)
	cfg, err := config.Normalize(raw)
	if err != nil {
		return nil, err
	}
	ws := &Workspace{
		Root:       absRoot,
		Name:       rootConfig.Workspace,
		StatePath:  absPath(absRoot, rootConfig.Backend.Local.State),
		Config:     cfg,
		Providers:  providers,
		AgentFiles: agentFiles,
		Vaults:     vaults,
		VaultFiles: vaultFiles,
	}
	return ws, ws.Validate()
}

func applyLegacyTailscaleDefault(raw *config.RawConfig, providers Providers) {
	if providers.Has("tailscale.default") || !providers.Has("tailscale.tvc") {
		return
	}
	for i := range raw.Agents {
		if raw.Agents[i].Network == nil {
			network := "tailscale.tvc"
			raw.Agents[i].Network = &network
		}
	}
	if raw.OpenWebUI.Network == nil && rawOpenWebUIConfigured(raw.OpenWebUI) {
		network := "tailscale.tvc"
		raw.OpenWebUI.Network = &network
	}
}

func rawOpenWebUIConfigured(raw config.RawOpenWebUI) bool {
	return raw.Enabled != nil ||
		raw.ID != nil ||
		raw.Runtime != nil ||
		raw.Lifecycle != nil ||
		raw.Protect != nil ||
		raw.FlyApp != nil ||
		raw.TailscaleHostname != nil ||
		raw.Region != nil ||
		raw.VolumeName != nil ||
		raw.VolumeSizeGB != nil ||
		raw.Memory != nil ||
		raw.CPUs != nil ||
		raw.Port != nil ||
		raw.Name != nil ||
		raw.TailscaleServe != nil ||
		raw.TailscaleAcceptDNS != nil ||
		raw.TailscaleAuthKeySecretName != nil ||
		raw.WebUISecretKeySecretName != nil ||
		raw.OpenAIAPIKeysSecretName != nil ||
		raw.TSExtraArgs != nil ||
		raw.TailscaledExtraArgs != nil
}

func (r *rootFile) defaults(workspaceName string) {
	if r.Workspace == "" {
		r.Workspace = workspaceName
	}
	if r.Backend.Local.State == "" {
		r.Backend.Local.State = ".companion/state.sqlite"
	}
	if r.Load.Providers == "" {
		r.Load.Providers = "providers.toml"
	}
	if r.Load.Defaults == "" {
		r.Load.Defaults = "defaults.toml"
	}
	if r.Load.WebUI == "" {
		r.Load.WebUI = "webui.toml"
	}
	if r.Load.Dashboard == "" {
		r.Load.Dashboard = "dashboard.toml"
	}
	if r.Load.Agents == "" {
		r.Load.Agents = "agents/*.toml"
	}
}

func (w *Workspace) Validate() error {
	if w.Name == "" {
		return fmt.Errorf("workspace name is required")
	}
	for _, agent := range w.Config.Agents {
		if !strings.HasPrefix(agent.Runtime, "fly.") {
			return fmt.Errorf("agent %s runtime must reference a fly provider", agent.ID)
		}
		if !w.Providers.Has(agent.Runtime) {
			return fmt.Errorf("agent %s references unknown runtime provider %s", agent.ID, agent.Runtime)
		}
		if !strings.HasPrefix(agent.Network, "tailscale.") {
			return fmt.Errorf("agent %s network must reference a tailscale provider", agent.ID)
		}
		if !w.Providers.Has(agent.Network) {
			return fmt.Errorf("agent %s references unknown network provider %s", agent.ID, agent.Network)
		}
		if !strings.HasPrefix(agent.ModelProvider, "openrouter.") {
			return fmt.Errorf("agent %s model_provider must reference an openrouter provider", agent.ID)
		}
		if !w.Providers.Has(agent.ModelProvider) {
			return fmt.Errorf("agent %s references unknown model provider %s", agent.ID, agent.ModelProvider)
		}
		if agent.Identity.Enabled && filepath.IsAbs(agent.Identity.Path) {
			return fmt.Errorf("agent %s identity path must be relative to the workspace", agent.ID)
		}
	}
	if w.Config.OpenWebUI.Enabled {
		if !strings.HasPrefix(w.Config.OpenWebUI.Runtime, "fly.") {
			return fmt.Errorf("open_webui runtime must reference a fly provider")
		}
		if !w.Providers.Has(w.Config.OpenWebUI.Runtime) {
			return fmt.Errorf("open_webui references unknown runtime provider %s", w.Config.OpenWebUI.Runtime)
		}
		if !strings.HasPrefix(w.Config.OpenWebUI.Network, "tailscale.") {
			return fmt.Errorf("open_webui network must reference a tailscale provider")
		}
		if !w.Providers.Has(w.Config.OpenWebUI.Network) {
			return fmt.Errorf("open_webui references unknown network provider %s", w.Config.OpenWebUI.Network)
		}
	}
	if w.Config.Dashboard.Enabled {
		if !strings.HasPrefix(w.Config.Dashboard.Runtime, "fly.") {
			return fmt.Errorf("dashboard runtime must reference a fly provider")
		}
		if !w.Providers.Has(w.Config.Dashboard.Runtime) {
			return fmt.Errorf("dashboard references unknown runtime provider %s", w.Config.Dashboard.Runtime)
		}
		if !strings.HasPrefix(w.Config.Dashboard.Network, "tailscale.") {
			return fmt.Errorf("dashboard network must reference a tailscale provider")
		}
		if !w.Providers.Has(w.Config.Dashboard.Network) {
			return fmt.Errorf("dashboard references unknown network provider %s", w.Config.Dashboard.Network)
		}
	}
	seenVaults := map[string]bool{}
	for _, vault := range w.Vaults {
		if !nameRE.MatchString(vault.ID) {
			return fmt.Errorf("vault id=%q must use lowercase letters, numbers, and dashes", vault.ID)
		}
		if seenVaults[vault.ID] {
			return fmt.Errorf("duplicate vault id: %s", vault.ID)
		}
		seenVaults[vault.ID] = true
		if vault.Lifecycle != "present" && vault.Lifecycle != "absent" {
			return fmt.Errorf("vault %s lifecycle must be present or absent", vault.ID)
		}
	}
	return nil
}

func (p Providers) Has(ref string) bool {
	kind, name, ok := strings.Cut(ref, ".")
	if !ok || name == "" {
		return false
	}
	switch kind {
	case "fly":
		_, ok := p.Fly[name]
		return ok
	case "tailscale":
		_, ok := p.Tailscale[name]
		return ok
	case "openrouter":
		_, ok := p.OpenRouter[name]
		return ok
	default:
		return false
	}
}

func loadProviders(root, pattern string) (Providers, error) {
	var providers Providers
	if err := readOptionalTOML(filepath.Join(root, filepath.FromSlash(pattern)), &providers); err != nil {
		return providers, err
	}
	if providers.Fly == nil {
		providers.Fly = map[string]FlyProvider{"default": {Region: "cdg", TokenEnv: "FLY_API_TOKEN"}}
	}
	if providers.Tailscale == nil {
		providers.Tailscale = map[string]TailscaleProvider{"default": {APIKeyEnv: "TAILSCALE_API_KEY", AuthKeySecret: "TS_AUTHKEY"}}
	}
	if providers.OpenRouter == nil {
		providers.OpenRouter = map[string]OpenRouterProvider{"default": {BaseURL: "https://openrouter.ai/api/v1", APIKeyEnv: "OPENROUTER_API_KEY"}}
	}
	for name, provider := range providers.Fly {
		provider.Mode = defaultProviderMode(provider.Mode)
		if provider.TokenEnv != "" && !envNameRE.MatchString(provider.TokenEnv) {
			return providers, fmt.Errorf("fly.%s token_env must be an environment variable name", name)
		}
		if err := validateProviderMode("fly."+name, provider.Mode); err != nil {
			return providers, err
		}
		if err := validateProviderURL("fly."+name, provider.APIBaseURL); err != nil {
			return providers, err
		}
		providers.Fly[name] = provider
	}
	for name, provider := range providers.Tailscale {
		provider.Mode = defaultProviderMode(provider.Mode)
		if provider.APIKeyEnv != "" && !envNameRE.MatchString(provider.APIKeyEnv) {
			return providers, fmt.Errorf("tailscale.%s api_key_env must be an environment variable name", name)
		}
		if provider.AuthKeySecret != "" && !envNameRE.MatchString(provider.AuthKeySecret) {
			return providers, fmt.Errorf("tailscale.%s auth_key_secret must be an environment variable name", name)
		}
		if err := validateProviderMode("tailscale."+name, provider.Mode); err != nil {
			return providers, err
		}
		if err := validateProviderURL("tailscale."+name, provider.APIBaseURL); err != nil {
			return providers, err
		}
		providers.Tailscale[name] = provider
	}
	for name, provider := range providers.OpenRouter {
		if provider.APIKeyEnv != "" && !envNameRE.MatchString(provider.APIKeyEnv) {
			return providers, fmt.Errorf("openrouter.%s api_key_env must be an environment variable name", name)
		}
		if err := validateProviderURL("openrouter."+name, firstNonEmpty(provider.APIBaseURL, provider.BaseURL)); err != nil {
			return providers, err
		}
	}
	return providers, nil
}

func defaultProviderMode(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return "cli"
	}
	return value
}

func validateProviderMode(ref, mode string) error {
	switch mode {
	case "cli", "api":
		return nil
	default:
		return fmt.Errorf("%s mode must be cli or api", ref)
	}
}

func validateProviderURL(ref, value string) error {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("%s api_base_url must be an absolute URL", ref)
	}
	return nil
}

func loadDefaults(root, pattern string, raw *config.RawConfig) error {
	var file defaultsFile
	if err := readOptionalTOML(filepath.Join(root, filepath.FromSlash(pattern)), &file); err != nil {
		return err
	}
	raw.Defaults = file.Defaults
	return nil
}

func loadWebUI(root, pattern string, raw *config.RawConfig) error {
	var file webUIFile
	if err := readOptionalTOML(filepath.Join(root, filepath.FromSlash(pattern)), &file); err != nil {
		return err
	}
	raw.OpenWebUI = file.OpenWebUI
	return nil
}

func loadDashboard(root, pattern string, raw *config.RawConfig) error {
	var file dashboardFile
	if err := readOptionalTOML(filepath.Join(root, filepath.FromSlash(pattern)), &file); err != nil {
		return err
	}
	raw.Dashboard = file.Dashboard
	return nil
}

func loadAgents(root, pattern string, raw *config.RawConfig) (map[string]string, error) {
	matches, err := filepath.Glob(filepath.Join(root, filepath.FromSlash(pattern)))
	if err != nil {
		return nil, err
	}
	sort.Strings(matches)
	files := map[string]string{}
	for _, path := range matches {
		var file agentFile
		if err := readTOML(path, &file); err != nil {
			return nil, err
		}
		agent := file.toRawAgent()
		if agent.ID == nil || *agent.ID == "" {
			return nil, fmt.Errorf("%s is missing [agent].id", path)
		}
		raw.Agents = append(raw.Agents, agent)
		files[*agent.ID] = path
	}
	return files, nil
}

func loadVaults(root, pattern string) ([]Vault, map[string]string, error) {
	if pattern == "" {
		return nil, map[string]string{}, nil
	}
	matches, err := filepath.Glob(filepath.Join(root, filepath.FromSlash(pattern)))
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(matches)
	files := map[string]string{}
	vaults := []Vault{}
	for _, path := range matches {
		var file vaultFile
		if err := readTOML(path, &file); err != nil {
			return nil, nil, err
		}
		id := stringValue(file.Vault.ID, "")
		if id == "" {
			return nil, nil, fmt.Errorf("%s is missing [vault].id", path)
		}
		vault := Vault{ID: id, Lifecycle: stringValue(file.Vault.Lifecycle, "present")}
		vaults = append(vaults, vault)
		files[vault.ID] = path
	}
	return vaults, files, nil
}

func (f agentFile) toRawAgent() config.RawAgent {
	identity := f.Identity
	if f.Agent.IdentityPath != nil {
		identity.Path = f.Agent.IdentityPath
		if identity.Enabled == nil {
			enabled := true
			identity.Enabled = &enabled
		}
	}
	connections := f.VaultConnection
	if len(f.VaultConnections) > 0 {
		connections = append(connections, f.VaultConnections...)
	}
	return config.RawAgent{
		ID:                         f.Agent.ID,
		Runtime:                    f.Agent.Runtime,
		Network:                    f.Agent.Network,
		ModelProvider:              f.Agent.ModelProvider,
		Lifecycle:                  f.Agent.Lifecycle,
		Protect:                    f.Agent.Protect,
		FlyApp:                     f.Agent.FlyApp,
		TailscaleHostname:          f.Agent.TailscaleHostname,
		Region:                     f.Agent.Region,
		VolumeName:                 f.Agent.VolumeName,
		VolumeSizeGB:               f.Agent.VolumeSizeGB,
		Memory:                     f.Agent.Memory,
		CPUs:                       f.Agent.CPUs,
		DashboardMode:              f.Agent.DashboardMode,
		DashboardHost:              f.Agent.DashboardHost,
		DashboardInsecure:          f.Agent.DashboardInsecure,
		DashboardPort:              f.Agent.DashboardPort,
		GraniteEnabled:             f.Agent.GraniteEnabled,
		TailscaleAuthKeySecretName: f.Agent.TailscaleAuthKeySecretName,
		TailscaleAcceptDNS:         f.Agent.TailscaleAcceptDNS,
		TSExtraArgs:                f.Agent.TSExtraArgs,
		TailscaledExtraArgs:        f.Agent.TailscaledExtraArgs,
		GraniteTemplate:            f.Agent.GraniteTemplate,
		Identity:                   identity,
		Model:                      f.Model,
		APIServer:                  f.APIServer,
		DefaultVault:               f.DefaultVault,
		VaultConnections:           connections,
	}
}

func absPath(root, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(root, filepath.FromSlash(path))
}

func stringValue(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func readOptionalTOML(path string, target any) error {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return readTOML(path, target)
}

func readTOML(path string, target any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := toml.Unmarshal(data, target); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}
