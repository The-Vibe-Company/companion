package render

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
)

func AgentFlyTOML(agent config.Agent) (string, error) {
	modelJSON, err := compactJSON(agent.Model)
	if err != nil {
		return "", err
	}
	defaultVaultJSON, err := compactJSON(agent.DefaultVault)
	if err != nil {
		return "", err
	}
	if agent.VaultConnections == nil {
		agent.VaultConnections = []config.VaultConnection{}
	}
	vaultConnectionsJSON, err := compactJSON(agent.VaultConnections)
	if err != nil {
		return "", err
	}
	identityJSON := ""
	if identity, ok := EffectiveAgentIdentity(agent); ok {
		identityJSON, err = compactJSON(identity)
		if err != nil {
			return "", err
		}
	}

	env := map[string]string{
		"GRANITE_DEFAULT_VAULT_JSON":     defaultVaultJSON,
		"GRANITE_ENABLED":                envBool(agent.GraniteEnabled),
		"GRANITE_VAULT_CONNECTIONS_JSON": vaultConnectionsJSON,
		"HERMES_DASHBOARD_HOST":          agent.DashboardHost,
		"HERMES_DASHBOARD_INSECURE":      envBool(agent.DashboardInsecure),
		"HERMES_DASHBOARD_MODE":          agent.DashboardMode,
		"HERMES_DASHBOARD_PORT":          strconv.Itoa(agent.DashboardPort),
		"HERMES_MODEL_JSON":              modelJSON,
		"TS_ACCEPT_DNS":                  envBool(agent.TailscaleAcceptDNS),
		"TS_HOSTNAME":                    agent.TailscaleHostname,
	}
	if identityJSON != "" {
		env["HERMES_IDENTITY_JSON"] = identityJSON
	}
	if agent.APIServer.Enabled {
		env["API_SERVER_ENABLED"] = "true"
		env["API_SERVER_HOST"] = agent.APIServer.Host
		env["API_SERVER_MODEL_NAME"] = agent.APIServer.ModelName
		env["API_SERVER_PORT"] = strconv.Itoa(agent.APIServer.Port)
		if agent.APIServer.CORSOrigins != "" {
			env["API_SERVER_CORS_ORIGINS"] = agent.APIServer.CORSOrigins
		}
	} else {
		env["API_SERVER_ENABLED"] = "false"
	}
	if agent.TSExtraArgs != "" {
		env["TS_EXTRA_ARGS"] = agent.TSExtraArgs
	}
	if agent.TailscaledExtraArgs != "" {
		env["TAILSCALED_EXTRA_ARGS"] = agent.TailscaledExtraArgs
	}
	if agent.GraniteTemplate != "" {
		env["GRANITE_TEMPLATE"] = agent.GraniteTemplate
	}

	lines := []string{
		fmt.Sprintf("app = %s", quote(agent.FlyApp)),
		fmt.Sprintf("primary_region = %s", quote(agent.Region)),
		`kill_signal = "SIGTERM"`,
		"kill_timeout = 30",
		"",
		"[build]",
		`  dockerfile = "../../Dockerfile"`,
		"",
		"[env]",
	}
	appendEnv(&lines, env)
	lines = append(lines,
		"",
		"[processes]",
		`  app = "gateway run"`,
		"",
		"[[mounts]]",
		fmt.Sprintf("  source = %s", quote(agent.VolumeName)),
		`  destination = "/opt/data"`,
		"",
		"[[vm]]",
		fmt.Sprintf("  memory = %s", quote(agent.Memory)),
		fmt.Sprintf("  cpus = %d", agent.CPUs),
		"",
	)
	return strings.Join(lines, "\n"), nil
}

func EffectiveAgentIdentity(agent config.Agent) (config.Identity, bool) {
	soul := ""
	if agent.Identity.Enabled {
		soul = strings.TrimRight(agent.Identity.Soul, "\n")
	}
	if agent.CompanionSoul.Enabled {
		companionSoul := strings.TrimRight(agent.CompanionSoul.Text, "\n")
		if strings.TrimSpace(companionSoul) != "" {
			if strings.TrimSpace(soul) != "" {
				soul += "\n\n"
			}
			soul += companionSoul
		}
	}
	if strings.TrimSpace(soul) == "" {
		return config.Identity{}, false
	}
	overwrite := agent.Identity.Overwrite
	if !agent.Identity.Enabled && agent.Identity.Path == "" && agent.Identity.Soul == "" {
		overwrite = true
	}
	return config.Identity{
		Enabled:   true,
		Soul:      soul,
		Overwrite: overwrite,
	}, true
}

func OpenWebUIFlyTOML(cfg config.OpenWebUI, connections []config.OpenWebUIConnection) (string, error) {
	if !cfg.Enabled {
		return "", fmt.Errorf("open_webui is disabled in companion.toml")
	}
	if len(connections) == 0 {
		return "", fmt.Errorf("open_webui has no enabled Hermes API server connections")
	}
	connectionsJSON, err := compactJSON(connections)
	if err != nil {
		return "", err
	}
	baseURLs := make([]string, len(connections))
	for i, connection := range connections {
		baseURLs[i] = connection.URL
	}
	env := map[string]string{
		"ENABLE_OLLAMA_API":           "false",
		"ENABLE_OPENAI_API":           "true",
		"ENABLE_PERSISTENT_CONFIG":    "false",
		"HF_HOME":                     "/app/backend/data/cache/huggingface",
		"OPENAI_API_BASE_URL":         baseURLs[0],
		"OPENAI_API_BASE_URLS":        strings.Join(baseURLs, ";"),
		"OPEN_WEBUI_CONNECTIONS_JSON": connectionsJSON,
		"OPEN_WEBUI_TAILSCALE_SERVE":  envBool(cfg.TailscaleServe),
		"OPEN_WEBUI_TS_HOSTNAME":      cfg.TailscaleHostname,
		"PORT":                        strconv.Itoa(cfg.Port),
		"SENTENCE_TRANSFORMERS_HOME":  "/app/backend/data/cache/sentence-transformers",
		"TIKTOKEN_CACHE_DIR":          "/app/backend/data/cache/tiktoken",
		"TS_ACCEPT_DNS":               envBool(cfg.TailscaleAcceptDNS),
		"USER_AGENT":                  "CompanionOpenWebUI/1.0",
		"WEBUI_NAME":                  cfg.Name,
	}
	if cfg.TSExtraArgs != "" {
		env["TS_EXTRA_ARGS"] = cfg.TSExtraArgs
	}
	if cfg.TailscaledExtraArgs != "" {
		env["TAILSCALED_EXTRA_ARGS"] = cfg.TailscaledExtraArgs
	}

	lines := []string{
		fmt.Sprintf("app = %s", quote(cfg.FlyApp)),
		fmt.Sprintf("primary_region = %s", quote(cfg.Region)),
		`kill_signal = "SIGTERM"`,
		"kill_timeout = 30",
		"",
		"[build]",
		`  dockerfile = "../../Dockerfile.open-webui"`,
		"",
		"[env]",
	}
	appendEnv(&lines, env)
	lines = append(lines,
		"",
		"[processes]",
		`  app = "bash start.sh"`,
		"",
		"[[mounts]]",
		fmt.Sprintf("  source = %s", quote(cfg.VolumeName)),
		`  destination = "/app/backend/data"`,
		"",
		"[[vm]]",
		fmt.Sprintf("  memory = %s", quote(cfg.Memory)),
		fmt.Sprintf("  cpus = %d", cfg.CPUs),
		"",
	)
	return strings.Join(lines, "\n"), nil
}

// DashboardFlyTOML renders the Fly config for the dedicated status dashboard.
// The dashboard is stateless: no [[mounts]] block, and the smallest possible
// machine. It declares no Fly HTTP service, so it is reached only over
// Tailscale Serve.
func DashboardFlyTOML(cfg config.Dashboard) (string, error) {
	if !cfg.Enabled {
		return "", fmt.Errorf("dashboard is disabled in the workspace")
	}
	env := map[string]string{
		"PORT":                      strconv.Itoa(cfg.Port),
		"DASHBOARD_TS_HOSTNAME":     cfg.TailscaleHostname,
		"DASHBOARD_TAILSCALE_SERVE": envBool(cfg.TailscaleServe),
		"TS_ACCEPT_DNS":             envBool(cfg.TailscaleAcceptDNS),
		"TAILSCALE_STATE_DIR":       "/tmp/tailscale",
		"COMPANION_DASHBOARD_NAME":  cfg.Name,
		"COMPANION_FLEET_MANIFEST":  "/workspace/fleet.json",
	}
	if cfg.TSExtraArgs != "" {
		env["TS_EXTRA_ARGS"] = cfg.TSExtraArgs
	}
	if cfg.TailscaledExtraArgs != "" {
		env["TAILSCALED_EXTRA_ARGS"] = cfg.TailscaledExtraArgs
	}

	process := fmt.Sprintf("companion dashboard --manifest /workspace/fleet.json --interval %ds", cfg.RefreshInterval)
	lines := []string{
		fmt.Sprintf("app = %s", quote(cfg.FlyApp)),
		fmt.Sprintf("primary_region = %s", quote(cfg.Region)),
		`kill_signal = "SIGTERM"`,
		"kill_timeout = 30",
		"",
		"[build]",
		`  dockerfile = "../../Dockerfile.dashboard"`,
		"",
		"[env]",
	}
	appendEnv(&lines, env)
	lines = append(lines,
		"",
		"[processes]",
		fmt.Sprintf("  app = %s", quote(process)),
		"",
		"[[vm]]",
		`  cpu_kind = "shared"`,
		fmt.Sprintf("  memory = %s", quote(cfg.Memory)),
		fmt.Sprintf("  cpus = %d", cfg.CPUs),
		"",
	)
	return strings.Join(lines, "\n"), nil
}

// RequiredDashboardFlySecrets lists the read-only tokens the dashboard machine
// needs as Fly secrets. The topology manifest itself is non-secret.
func RequiredDashboardFlySecrets(cfg config.Dashboard) []string {
	return unique([]string{
		cfg.TailscaleAuthKeySecretName,
		cfg.FlyTokenSecretName,
		cfg.TailscaleAPIKeySecretName,
	})
}

func RequiredAgentSecrets(agent config.Agent) []string {
	names := []string{agent.TailscaleAuthKeySecretName}
	if agent.Model.APIKeySecretName != "" {
		names = append(names, agent.Model.APIKeySecretName)
	}
	for _, secret := range agent.Model.Secrets {
		names = append(names, secret)
	}
	if agent.APIServer.Enabled {
		names = append(names, agent.APIServer.KeySecretName)
	}
	for _, connection := range agent.VaultConnections {
		if connection.TokenSecretName != "" {
			names = append(names, connection.TokenSecretName)
		}
	}
	return unique(names)
}

func RequiredOpenWebUIInputSecrets(cfg config.OpenWebUI, connections []config.OpenWebUIConnection) []string {
	names := []string{cfg.TailscaleAuthKeySecretName, cfg.WebUISecretKeySecretName}
	for _, connection := range connections {
		names = append(names, connection.KeySecretName)
	}
	return unique(names)
}

func RequiredOpenWebUIFlySecrets(cfg config.OpenWebUI) []string {
	return unique([]string{
		cfg.TailscaleAuthKeySecretName,
		cfg.WebUISecretKeySecretName,
		cfg.OpenAIAPIKeysSecretName,
		"OPENAI_API_KEY",
	})
}

func OpenWebUISecretValues(cfg config.OpenWebUI, connections []config.OpenWebUIConnection, env map[string]string) (map[string]string, error) {
	values := map[string]string{}
	for _, name := range RequiredOpenWebUIInputSecrets(cfg, connections) {
		value, ok := env[name]
		if !ok || value == "" {
			return nil, fmt.Errorf("set %s in .env or your local environment before apply", name)
		}
		values[name] = value
	}
	keys := make([]string, len(connections))
	for i, connection := range connections {
		keys[i] = env[connection.KeySecretName]
	}
	values[cfg.OpenAIAPIKeysSecretName] = strings.Join(keys, ";")
	values["OPENAI_API_KEY"] = keys[0]
	return values, nil
}

func appendEnv(lines *[]string, env map[string]string) {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		*lines = append(*lines, fmt.Sprintf("  %s = %s", key, quote(env[key])))
	}
}

func compactJSON(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func quote(value string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`) + `"`
}

func envBool(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func unique(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
