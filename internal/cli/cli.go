package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/deps"
	"github.com/The-Vibe-Company/companion/internal/envfile"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/hermes"
	"github.com/The-Vibe-Company/companion/internal/importer"
	"github.com/The-Vibe-Company/companion/internal/outputs"
	"github.com/The-Vibe-Company/companion/internal/plan"
	"github.com/The-Vibe-Company/companion/internal/provider"
	"github.com/The-Vibe-Company/companion/internal/render"
	"github.com/The-Vibe-Company/companion/internal/resource"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
	"github.com/The-Vibe-Company/companion/internal/tailscalectl"
	"github.com/The-Vibe-Company/companion/internal/vaultops"
	"github.com/The-Vibe-Company/companion/internal/version"
	"github.com/The-Vibe-Company/companion/internal/web"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

type app struct {
	rootDir string
	envFile string
	runner  execx.Runner
}

func NewRootCommand() *cobra.Command {
	return newRootCommand(nil)
}

func newRootCommand(runner execx.Runner) *cobra.Command {
	a := &app{runner: runner}
	cmd := &cobra.Command{
		Use:           "companion",
		Short:         "Manage the Companion Hermes fleet",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	cmd.PersistentFlags().StringVar(&a.rootDir, "workspace", ".", "Companion workspace directory")
	cmd.PersistentFlags().StringVar(&a.envFile, "env-file", ".env", "secret env file; shell variables override file values")

	cmd.AddCommand(a.initCommand())
	cmd.AddCommand(a.fmtCommand())
	cmd.AddCommand(a.resourceImportCommand())
	cmd.AddCommand(a.validateCommand())
	cmd.AddCommand(a.planCommand())
	cmd.AddCommand(a.applyCommand())
	cmd.AddCommand(a.destroyCommand())
	cmd.AddCommand(a.statusCommand())
	cmd.AddCommand(a.graphCommand())
	cmd.AddCommand(a.identityCommand())
	cmd.AddCommand(a.outputCommand())
	cmd.AddCommand(a.stateCommand())
	cmd.AddCommand(a.tailscaleCommand())
	cmd.AddCommand(a.vaultCommand())
	cmd.AddCommand(a.serveCommand())
	cmd.AddCommand(a.versionCommand())
	return cmd
}

func (a *app) initCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "init",
		Short: "Create a folder-based Companion workspace",
		RunE: func(cmd *cobra.Command, args []string) error {
			root := a.rootDir
			if root == "" {
				root = "."
			}
			files := map[string]string{
				"companion.toml": `workspace = "companion"

[backend.local]
state = ".companion/state.sqlite"

[load]
providers = "providers.toml"
defaults = "defaults.toml"
webui = "webui.toml"
agents = "agents/*.toml"
vaults = "vaults/*.toml"
`,
				"providers.toml": `[fly.default]
region = "cdg"
token_env = "FLY_API_TOKEN"
# mode = "api"
# api_base_url = "http://127.0.0.1:3001/fly/v1"

[tailscale.default]
api_key_env = "TAILSCALE_API_KEY"
auth_key_secret = "TS_AUTHKEY"
# mode = "api"
# api_base_url = "http://127.0.0.1:3001/tailscale"

[openrouter.default]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
# api_base_url = "http://127.0.0.1:3001/openrouter/api/v1"
`,
				"defaults.toml": `[defaults]
region = "cdg"
volume_name = "data"
volume_size_gb = 3
memory = "4gb"
cpus = 2
dashboard_mode = "serve"
dashboard_host = "0.0.0.0"
dashboard_insecure = true
dashboard_port = 9119
granite_enabled = true
tailscale_authkey_secret_name = "TS_AUTHKEY"
ts_extra_args = "--netfilter-mode=off"

[defaults.model]
enabled = true
provider = "openrouter"
default = "google/gemini-3.5-flash"
base_url = "https://openrouter.ai/api/v1"
api_key_secret_name = "OPENROUTER_API_KEY"
api_key_env = "OPENROUTER_API_KEY"

[defaults.api_server]
enabled = true
host = "0.0.0.0"
port = 8642

[defaults.default_vault]
enabled = true
path = "/opt/data/.granite"
mcp_enabled = true
mcp_name = "granite"
mcp_role = "write"
sync_serve = true
sync_port = 8765
write_serve = true
write_port = 3321
sync_interval = 30
`,
				"webui.toml": `[open_webui]
enabled = true
id = "open-webui"
runtime = "fly.default"
network = "tailscale.default"
lifecycle = "present"
protect = true
fly_app = "example-companion-webui"
tailscale_hostname = "companion-webui"
region = "cdg"
volume_name = "open_webui_data"
volume_size_gb = 5
memory = "4gb"
cpus = 2
port = 8080
name = "Companion"
tailscale_serve = true
tailscale_accept_dns = true
tailscale_authkey_secret_name = "TS_AUTHKEY"
webui_secret_key_secret_name = "WEBUI_SECRET_KEY"
openai_api_keys_secret_name = "OPENAI_API_KEYS"
ts_extra_args = "--netfilter-mode=off"
`,
				filepath.Join("agents", "sample.toml"): `[agent]
id = "sample"
runtime = "fly.default"
network = "tailscale.default"
model_provider = "openrouter.default"
lifecycle = "present"
protect = true
fly_app = "example-companion-sample"
tailscale_hostname = "sample"
identity = "identities/sample/SOUL.md"

[default_vault]
enabled = true
name = "Sample Agent"
mcp_role = "write"
`,
				filepath.Join("identities", "sample", "SOUL.md"): identityTemplate("Sample Agent"),
			}
			for name, contents := range files {
				path := filepath.Join(root, name)
				if _, err := os.Stat(path); err == nil {
					return fmt.Errorf("%s already exists", path)
				} else if err != nil && !os.IsNotExist(err) {
					return err
				}
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					return err
				}
				if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
					return err
				}
			}
			fmt.Fprintf(cmd.OutOrStdout(), "initialized Companion workspace in %s\n", root)
			return nil
		},
	}
}

func (a *app) fmtCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "fmt",
		Short: "Validate workspace TOML formatting",
		RunE: func(cmd *cobra.Command, args []string) error {
			if _, err := a.workspace(); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "workspace toml ok")
			return nil
		},
	}
}

func (a *app) resourceImportCommand() *cobra.Command {
	var attrs []string
	cmd := &cobra.Command{
		Use:   "import <resource-address> <external-id>",
		Short: "Import an existing external resource into local observed state",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			address, err := importer.ParseAddress(args[0])
			if err != nil {
				return err
			}
			externalID := strings.TrimSpace(args[1])
			if externalID == "" {
				return fmt.Errorf("external id cannot be empty")
			}
			parsedAttrs, err := importer.ParseAttrs(attrs)
			if err != nil {
				return err
			}
			attrsJSON, err := json.Marshal(parsedAttrs)
			if err != nil {
				return fmt.Errorf("marshal attrs: %w", err)
			}
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			store, err := state.Open(ws.StatePath)
			if err != nil {
				return err
			}
			defer store.Close()
			resource := state.Resource{
				Address:      address.Raw,
				Class:        "managed",
				ProviderRef:  providerRefForImport(ws, address),
				ExternalID:   externalID,
				Status:       "ready",
				ObservedJSON: string(attrsJSON),
			}
			if err := store.ImportResource(cmd.Context(), resource); err != nil {
				return err
			}
			if err := store.RecordEvent(cmd.Context(), "import", address.Raw, "info", "imported resource", map[string]string{
				"type":        address.Type,
				"group":       address.Group,
				"name":        address.Name,
				"external_id": externalID,
			}); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "imported %s -> %s\n", address.Raw, externalID)
			return nil
		},
	}
	cmd.Flags().StringArrayVar(&attrs, "attrs", nil, "resource metadata as key=value; can be repeated")
	return cmd
}

func providerRefForImport(ws *workspace.Workspace, address importer.Address) string {
	if address.Type == "tailscale_device" {
		if address.Group == "agent" {
			if agent, err := selectSingleAgent(ws.Config, address.Name); err == nil {
				return agent.Network
			}
		}
		if ws.Config.OpenWebUI.Enabled {
			return ws.Config.OpenWebUI.Network
		}
		return "tailscale.default"
	}
	if address.Group == "agent" || address.Group == "agent_data" || address.Group == "default" {
		if agent, err := selectSingleAgent(ws.Config, address.Name); err == nil {
			return agent.Runtime
		}
	}
	if strings.Contains(address.Raw, "openwebui") || address.Type == "openwebui_config" {
		if ws.Config.OpenWebUI.Enabled {
			return ws.Config.OpenWebUI.Runtime
		}
	}
	if strings.HasPrefix(address.Type, "fly_") || address.Type == "rollout" || address.Type == "granite_vault" {
		return "fly.default"
	}
	return address.Type
}

func workspaceProviderRefs(ws *workspace.Workspace) []string {
	seen := map[string]bool{}
	refs := []string{}
	add := func(ref string) {
		if ref == "" || seen[ref] {
			return
		}
		seen[ref] = true
		refs = append(refs, ref)
	}
	for _, agent := range ws.Config.Agents {
		add(agent.Runtime)
		add(agent.Network)
		add(agent.ModelProvider)
	}
	if ws.Config.OpenWebUI.Enabled {
		add(ws.Config.OpenWebUI.Runtime)
		add(ws.Config.OpenWebUI.Network)
	}
	return refs
}

func (a *app) validateCommand() *cobra.Command {
	var validateProviders bool
	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate the Companion workspace",
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			cfg := ws.Config
			for _, agent := range cfg.Agents {
				identity := "disabled"
				if agent.Identity.Enabled {
					identity = "inline"
					if agent.Identity.Path != "" {
						identity = agent.Identity.Path
					}
					if _, err := a.hydrateAgentIdentity(agent); err != nil {
						return err
					}
				}
				fmt.Fprintf(cmd.OutOrStdout(), "%s: ok runtime=%s network=%s fly_app=%s tailscale=%s lifecycle=%s identity=%s\n", agent.ID, agent.Runtime, agent.Network, agent.FlyApp, agent.TailscaleHostname, agent.Lifecycle, identity)
			}
			if cfg.OpenWebUI.Enabled {
				ids := []string{}
				for _, connection := range cfg.OpenWebUIConnections() {
					ids = append(ids, connection.AgentID)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "%s: ok runtime=%s network=%s fly_app=%s tailscale=%s connections=%s\n", cfg.OpenWebUI.ID, cfg.OpenWebUI.Runtime, cfg.OpenWebUI.Network, cfg.OpenWebUI.FlyApp, cfg.OpenWebUI.TailscaleHostname, strings.Join(ids, ","))
			}
			if validateProviders {
				env, err := a.env()
				if err != nil {
					return err
				}
				if err := provider.New(ws, env).ValidateCredentialsWithRunner(cmd.Context(), a.runnerWithEnv(env), workspaceProviderRefs(ws)...); err != nil {
					return err
				}
				providers, err := a.providerSet(ws, env)
				if err != nil {
					return err
				}
				if err := providers.ValidateModels(cmd.Context(), cfg); err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), "credentials: ok")
				fmt.Fprintln(cmd.OutOrStdout(), "providers: ok")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&validateProviders, "providers", false, "validate provider-backed model catalogs")
	return cmd
}

func (a *app) planCommand() *cobra.Command {
	var formatJSON bool
	cmd := &cobra.Command{
		Use:   "plan [address...]",
		Short: "Print the desired vs observed resource plan",
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			store, err := state.Open(ws.StatePath)
			if err != nil {
				return err
			}
			defer store.Close()
			env, err := a.env()
			if err != nil {
				return err
			}
			providers, err := a.providerSet(ws, env)
			if err != nil {
				return err
			}
			report, err := resource.BuildPlan(cmd.Context(), ws, store, providers, resource.Options{
				Root:         ws.Root,
				GeneratedDir: filepath.Join(ws.Root, ".companion", "generated"),
				Targets:      args,
			})
			if err != nil {
				return err
			}
			if formatJSON {
				data, err := report.JSON()
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), string(data))
			} else {
				fmt.Fprintln(cmd.OutOrStdout(), report.String())
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&formatJSON, "json", false, "print plan as JSON")
	return cmd
}

func (a *app) applyCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "apply [address...]",
		Short: "Apply the Companion resource plan",
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			env, err := a.env()
			if err != nil {
				return err
			}
			store, err := state.Open(ws.StatePath)
			if err != nil {
				return err
			}
			defer store.Close()
			providers, err := a.providerSet(ws, env)
			if err != nil {
				return err
			}
			report, err := resource.Apply(cmd.Context(), ws, store, providers, resource.Options{
				Root:         ws.Root,
				GeneratedDir: filepath.Join(ws.Root, ".companion", "generated"),
				Env:          env,
				Targets:      args,
			})
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), report.String())
			return nil
		},
	}
	return cmd
}

func (a *app) destroyCommand() *cobra.Command {
	var confirm string
	var destroyData bool
	var backupFirst bool
	cmd := &cobra.Command{
		Use:   "destroy <address>",
		Short: "Destroy a managed resource with explicit confirmation",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			if confirm == "" || !strings.Contains(args[0], confirm) {
				return fmt.Errorf("destroy requires --confirm with part of the resource address")
			}
			env, err := a.env()
			if err != nil {
				return err
			}
			store, err := state.Open(ws.StatePath)
			if err != nil {
				return err
			}
			defer store.Close()
			providers, err := a.providerSet(ws, env)
			if err != nil {
				return err
			}
			report, err := resource.Apply(cmd.Context(), ws, store, providers, resource.Options{
				Root:                  ws.Root,
				GeneratedDir:          filepath.Join(ws.Root, ".companion", "generated"),
				Env:                   env,
				DestroyTargets:        args,
				AllowProtectedDestroy: true,
				DestroyData:           destroyData,
				BackupFirst:           backupFirst,
			})
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), report.String())
			return nil
		},
	}
	cmd.Flags().StringVar(&confirm, "confirm", "", "required confirmation token")
	cmd.Flags().BoolVar(&destroyData, "destroy-data", false, "allow destroying persistent data resources")
	cmd.Flags().BoolVar(&backupFirst, "backup-first", false, "confirm persistent data was backed up first")
	return cmd
}

func (a *app) statusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status [agent-id...]",
		Short: "Check agent runtime health without mutating state",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			agents, err := cfg.SelectAgents(args)
			if err != nil {
				return err
			}
			env, err := a.env()
			if err != nil {
				return err
			}
			client := hermes.New()
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			providers, err := a.providerSet(ws, env)
			if err != nil {
				return err
			}
			devices, _ := providers.AllDevices(cmd.Context())
			for _, agent := range agents {
				if !agent.APIServer.Enabled {
					fmt.Fprintf(cmd.OutOrStdout(), "%s api=disabled\n", agent.ID)
					continue
				}
				baseURL := deps.AgentAPIBaseURL(agent, devices)
				health := client.Health(cmd.Context(), baseURL)
				if health.OK {
					fmt.Fprintf(cmd.OutOrStdout(), "%s health=ok url=%s\n", agent.ID, health.URL)
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "%s health=error url=%s detail=%s status=%d\n", agent.ID, health.URL, health.Error, health.Status)
				}
			}
			return nil
		},
	}
}

func (a *app) graphCommand() *cobra.Command {
	var format string
	cmd := &cobra.Command{
		Use:   "graph",
		Short: "Print the agent/vault graph",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			graph := plan.BuildGraph(cfg)
			if format == "json" {
				data, err := graph.JSON()
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), string(data))
				return nil
			}
			if format != "text" {
				return fmt.Errorf("--format must be text or json")
			}
			fmt.Fprintln(cmd.OutOrStdout(), graph.Text())
			return nil
		},
	}
	cmd.Flags().StringVar(&format, "format", "text", "text or json")
	return cmd
}

func (a *app) outputCommand() *cobra.Command {
	var format string
	var raw bool
	cmd := &cobra.Command{
		Use:   "output [name]",
		Short: "Print Terraform-style fleet outputs",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			env, err := a.env()
			if err != nil {
				return err
			}
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			providers, err := a.providerSet(ws, env)
			if err != nil {
				return err
			}
			flyProvider, err := providers.FlyFor(cfg.OpenWebUI.Runtime)
			if err != nil && len(cfg.Agents) > 0 {
				flyProvider, err = providers.FlyFor(cfg.Agents[0].Runtime)
			}
			if err != nil {
				return err
			}
			tsProvider, err := providers.TailscaleFor(cfg.OpenWebUI.Network)
			if err != nil && len(cfg.Agents) > 0 {
				tsProvider, err = providers.TailscaleFor(cfg.Agents[0].Network)
			}
			if err != nil {
				return err
			}
			fleetOutputs := outputs.Build(cmd.Context(), cfg, flyProvider, tsProvider)
			var value any = fleetOutputs
			if len(args) == 1 {
				value, err = outputs.Lookup(fleetOutputs, args[0])
				if err != nil {
					return err
				}
			}
			if raw {
				if len(args) == 0 {
					return fmt.Errorf("--raw requires an output name")
				}
				text, err := outputs.RawString(value)
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), text)
				return nil
			}
			switch format {
			case "text":
				if len(args) == 0 {
					fmt.Fprintln(cmd.OutOrStdout(), outputs.Text(fleetOutputs))
					return nil
				}
				if text, err := outputs.RawString(value); err == nil {
					fmt.Fprintln(cmd.OutOrStdout(), text)
					return nil
				}
				data, err := outputs.JSON(value)
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), string(data))
				return nil
			case "json":
				data, err := outputs.JSON(value)
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), string(data))
				return nil
			default:
				return fmt.Errorf("--format must be text or json")
			}
		},
	}
	cmd.Flags().StringVar(&format, "format", "text", "text or json")
	cmd.Flags().BoolVar(&raw, "raw", false, "print a single scalar output without formatting")
	return cmd
}

func (a *app) identityCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "identity",
		Short: "Manage Hermes SOUL.md identity files",
	}
	cmd.AddCommand(a.identityInitCommand())
	cmd.AddCommand(a.identityRenderCommand())
	return cmd
}

func (a *app) identityInitCommand() *cobra.Command {
	var name string
	var path string
	var force bool
	var overwrite bool
	cmd := &cobra.Command{
		Use:   "init <agent-id>",
		Short: "Create a local SOUL.md file and attach it to an agent",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			cfg := ws.Config
			agent, err := selectSingleAgent(cfg, args[0])
			if err != nil {
				return err
			}
			if path == "" {
				path = filepath.ToSlash(filepath.Join("identities", agent.ID, "SOUL.md"))
			}
			if filepath.IsAbs(path) {
				return fmt.Errorf("identity path must be relative to the Companion root")
			}
			if name == "" {
				name = humanNameFromID(agent.ID)
			}

			destination := filepath.Join(ws.Root, filepath.FromSlash(path))
			if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
				return err
			}
			if _, err := os.Stat(destination); err == nil && !force {
				return fmt.Errorf("%s already exists; rerun with --force to replace it", destination)
			} else if err != nil && !os.IsNotExist(err) {
				return err
			}
			if err := os.WriteFile(destination, []byte(identityTemplate(name)), 0o644); err != nil {
				return err
			}
			if err := updateAgentIdentityConfig(ws, agent.ID, path, overwrite); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", destination)
			fmt.Fprintf(cmd.OutOrStdout(), "updated agent=%s identity=%s\n", agent.ID, path)
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "human-readable agent name for the starter SOUL.md")
	cmd.Flags().StringVar(&path, "path", "", "relative SOUL.md path to create")
	cmd.Flags().BoolVar(&force, "force", false, "replace an existing local SOUL.md file")
	cmd.Flags().BoolVar(&overwrite, "overwrite", true, "overwrite remote HERMES_HOME/SOUL.md during apply")
	return cmd
}

func (a *app) identityRenderCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "render <agent-id>",
		Short: "Print the SOUL.md content that apply will install",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			agent, err := selectSingleAgent(cfg, args[0])
			if err != nil {
				return err
			}
			agent, err = a.hydrateAgentIdentity(agent)
			if err != nil {
				return err
			}
			if !agent.Identity.Enabled {
				return fmt.Errorf("agent %s identity is disabled", agent.ID)
			}
			fmt.Fprint(cmd.OutOrStdout(), agent.Identity.Soul)
			if !strings.HasSuffix(agent.Identity.Soul, "\n") {
				fmt.Fprintln(cmd.OutOrStdout())
			}
			return nil
		},
	}
}

func (a *app) serveCommand() *cobra.Command {
	var addr string
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Serve the local Companion dashboard",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			env, err := a.env()
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "serving Companion dashboard at http://%s\n", addr)
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			providers, err := a.providerSet(ws, env)
			if err != nil {
				return err
			}
			flyProvider, err := providers.FlyFor(cfg.OpenWebUI.Runtime)
			if err != nil && len(cfg.Agents) > 0 {
				flyProvider, err = providers.FlyFor(cfg.Agents[0].Runtime)
			}
			if err != nil {
				return err
			}
			tsProvider, err := providers.TailscaleFor(cfg.OpenWebUI.Network)
			if err != nil && len(cfg.Agents) > 0 {
				tsProvider, err = providers.TailscaleFor(cfg.Agents[0].Network)
			}
			if err != nil {
				return err
			}
			return web.Serve(cmd.Context(), addr, cfg, flyProvider, tsProvider)
		},
	}
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "listen address")
	return cmd
}

func (a *app) versionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the Companion CLI version",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Fprintln(cmd.OutOrStdout(), version.Version)
			return nil
		},
	}
}

func (a *app) stateCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "state",
		Short: "Inspect local observed state",
	}
	cmd.AddCommand(a.stateListCommand())
	cmd.AddCommand(a.stateShowCommand())
	cmd.AddCommand(a.stateRemoveCommand())
	return cmd
}

func (a *app) tailscaleCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tailscale",
		Short: "Manage Tailscale resources for the Companion fleet",
	}
	cmd.AddCommand(a.tailscaleCleanupCommand())
	return cmd
}

func (a *app) tailscaleCleanupCommand() *cobra.Command {
	var apply bool
	var apiBaseURL string
	cmd := &cobra.Command{
		Use:   "cleanup [agent-id...]",
		Short: "Remove offline duplicate Tailscale devices for Companion agents",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			agents, err := cfg.SelectAgents(args)
			if err != nil {
				return err
			}
			devices, err := a.tailscale().Devices(cmd.Context())
			if err != nil {
				return err
			}
			plan := tailscalectl.PlanCleanup(agents, devices)
			if len(plan.Candidates) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "= no-op tailscale cleanup")
				return nil
			}
			env := map[string]string{}
			if apply {
				env, err = a.env()
				if err != nil {
					return err
				}
			}
			for _, candidate := range plan.Candidates {
				if apply {
					if err := tailscale.DeleteDevice(cmd.Context(), apiBaseURL, env["TAILSCALE_API_KEY"], candidate.DeviceID); err != nil {
						return err
					}
					fmt.Fprintf(cmd.OutOrStdout(), "- deleted tailscale device %s agent=%s dns=%s reason=%s\n", candidate.DeviceID, candidate.AgentID, candidate.DNSName, candidate.Reason)
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "- would delete tailscale device %s agent=%s dns=%s reason=%s\n", candidate.DeviceID, candidate.AgentID, candidate.DNSName, candidate.Reason)
				}
			}
			if !apply {
				fmt.Fprintln(cmd.OutOrStdout(), "dry-run only; rerun with --apply and TAILSCALE_API_KEY in .env or shell to delete")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&apply, "apply", false, "delete the planned offline duplicate devices")
	cmd.Flags().StringVar(&apiBaseURL, "api-base-url", "", "override Tailscale API base URL for tests")
	return cmd
}

func (a *app) vaultCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "vault",
		Short: "Backup and restore agent Granite vaults",
	}
	cmd.AddCommand(a.vaultBackupCommand())
	cmd.AddCommand(a.vaultRestoreCommand())
	return cmd
}

func (a *app) vaultBackupCommand() *cobra.Command {
	var outDir string
	cmd := &cobra.Command{
		Use:   "backup <agent-id>",
		Short: "Create a local tar.gz backup of an agent default Granite vault",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			agent, err := selectSingleAgent(cfg, args[0])
			if err != nil {
				return err
			}
			destination := outDir
			if destination == "" {
				destination = filepath.Join(a.rootDir, ".companion", "backups")
			}
			env, err := a.env()
			if err != nil {
				return err
			}
			result, err := vaultops.Backup(cmd.Context(), a.flyWithEnv(env), agent, destination, time.Now().UTC())
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "backed up %s vault %s from %s to %s\n", result.AgentID, result.VaultPath, result.MachineID, result.LocalPath)
			return nil
		},
	}
	cmd.Flags().StringVar(&outDir, "out", "", "backup output directory")
	return cmd
}

func (a *app) vaultRestoreCommand() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "restore <agent-id> <backup.tgz>",
		Short: "Restore an agent default Granite vault from a local tar.gz backup",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !yes {
				return fmt.Errorf("restore replaces the remote vault; rerun with --yes")
			}
			cfg, err := a.load()
			if err != nil {
				return err
			}
			agent, err := selectSingleAgent(cfg, args[0])
			if err != nil {
				return err
			}
			env, err := a.env()
			if err != nil {
				return err
			}
			result, err := vaultops.Restore(cmd.Context(), a.flyWithEnv(env), agent, args[1], time.Now().UTC())
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "restored %s vault %s from %s; previous vault moved to %s\n", result.AgentID, result.VaultPath, result.BackupFilePath, result.PreviousVault)
			return nil
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "confirm remote vault replacement")
	return cmd
}

func (a *app) stateListCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List imported and observed resources",
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			store, err := state.Open(ws.StatePath)
			if err != nil {
				return err
			}
			defer store.Close()
			resources, err := store.ListResources(cmd.Context())
			if err != nil {
				return err
			}
			if len(resources) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "state is empty")
				return nil
			}
			for _, resource := range resources {
				observedAt := "unknown"
				if !resource.LastTransitionAt.IsZero() {
					observedAt = resource.LastTransitionAt.UTC().Format(time.RFC3339)
				}
				fmt.Fprintf(
					cmd.OutOrStdout(),
					"%s -> %s status=%s observed=%s\n",
					resource.Address,
					resource.ExternalID,
					resource.Status,
					observedAt,
				)
			}
			return nil
		},
	}
}

func (a *app) stateShowCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "show <address>",
		Short: "Show one observed resource",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			store, err := state.Open(ws.StatePath)
			if err != nil {
				return err
			}
			defer store.Close()
			resource, ok, err := store.GetResource(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("resource %s not found in state", args[0])
			}
			data, err := json.MarshalIndent(resource, "", "  ")
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), string(data))
			return nil
		},
	}
}

func (a *app) stateRemoveCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "rm <address>",
		Short: "Remove one resource from local state only",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ws, err := a.workspace()
			if err != nil {
				return err
			}
			store, err := state.Open(ws.StatePath)
			if err != nil {
				return err
			}
			defer store.Close()
			if err := store.RemoveResource(cmd.Context(), args[0]); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "removed %s from state\n", args[0])
			return nil
		},
	}
}

func (a *app) hydrateAgentIdentity(agent config.Agent) (config.Agent, error) {
	if !agent.Identity.Enabled {
		return agent, nil
	}
	if strings.TrimSpace(agent.Identity.Soul) != "" {
		return agent, nil
	}
	if agent.Identity.Path == "" {
		return agent, fmt.Errorf("agent %s identity requires path or soul", agent.ID)
	}
	path := agent.Identity.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(a.rootDir, filepath.FromSlash(path))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return agent, fmt.Errorf("read identity for agent %s: %w", agent.ID, err)
	}
	agent.Identity.Soul = string(data)
	return agent, nil
}

func agentSecrets(ctx context.Context, provider fly.Provider, agent config.Agent, reuseExisting bool, env map[string]string) (map[string]string, []string, error) {
	required := render.RequiredAgentSecrets(agent)
	values := secretValuesFromEnv(required, env)
	missing := missingSecretNames(required, values)
	if len(missing) == 0 {
		return values, nil, nil
	}
	if !reuseExisting {
		return nil, nil, fmt.Errorf("set %s in .env or your local environment before apply", strings.Join(missing, ", "))
	}
	if err := ensureFlySecretsExist(ctx, provider, agent.FlyApp, missing); err != nil {
		return nil, nil, err
	}
	return values, missing, nil
}

func openWebUISecrets(ctx context.Context, provider fly.Provider, cfg config.OpenWebUI, connections []config.OpenWebUIConnection, reuseExisting bool, env map[string]string) (map[string]string, error) {
	values, err := render.OpenWebUISecretValues(cfg, connections, env)
	if err == nil {
		return values, nil
	}
	if !reuseExisting {
		return nil, err
	}
	values = map[string]string{}
	missingReusable := []string{}
	for _, name := range []string{cfg.TailscaleAuthKeySecretName, cfg.WebUISecretKeySecretName} {
		if env[name] != "" {
			values[name] = env[name]
		} else {
			missingReusable = append(missingReusable, name)
		}
	}
	keys := make([]string, 0, len(connections))
	for _, connection := range connections {
		key := env[connection.KeySecretName]
		if key == "" {
			missingReusable = append(missingReusable, cfg.OpenAIAPIKeysSecretName, "OPENAI_API_KEY")
			break
		}
		keys = append(keys, key)
		values[connection.KeySecretName] = key
	}
	if len(keys) == len(connections) && len(keys) > 0 {
		values[cfg.OpenAIAPIKeysSecretName] = strings.Join(keys, ";")
		values["OPENAI_API_KEY"] = keys[0]
	}
	if err := ensureFlySecretsExist(ctx, provider, cfg.FlyApp, missingReusable); err != nil {
		return nil, err
	}
	return values, nil
}

func ensureFlySecretsExist(ctx context.Context, provider fly.Provider, app string, required []string) error {
	existing, err := provider.SecretNames(ctx, app)
	if err != nil {
		return err
	}
	missing := []string{}
	for _, name := range required {
		if !existing[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("set %s in .env or your local environment before apply; not found as existing Fly secrets on %s", strings.Join(missing, ", "), app)
	}
	return nil
}

func secretValuesFromEnv(required []string, env map[string]string) map[string]string {
	values := map[string]string{}
	for _, name := range required {
		if value := env[name]; value != "" {
			values[name] = value
		}
	}
	return values
}

func missingSecretNames(required []string, values map[string]string) []string {
	missing := []string{}
	for _, name := range required {
		if values[name] == "" {
			missing = append(missing, name)
		}
	}
	return missing
}

func printSecretsAction(cmd *cobra.Command, app string, values map[string]string, reused []string) {
	if len(values) > 0 {
		fmt.Fprintln(cmd.OutOrStdout(), fly.RedactedSecretsCommand(app, values))
	}
	if len(reused) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "= no-op secrets %s reused %s\n", app, strings.Join(reused, ","))
	}
}

func reusedSecretNames(values map[string]string, required []string) []string {
	reused := []string{}
	for _, name := range required {
		if values[name] == "" {
			reused = append(reused, name)
		}
	}
	return reused
}

func (a *app) load() (*config.Config, error) {
	ws, err := a.workspace()
	if err != nil {
		return nil, err
	}
	return ws.Config, nil
}

func (a *app) workspace() (*workspace.Workspace, error) {
	return workspace.Load(a.rootDir)
}

func (a *app) providerSet(ws *workspace.Workspace, env map[string]string) (provider.Set, error) {
	return provider.NewSet(ws, env, a.runnerWithEnv(env))
}

func (a *app) env() (map[string]string, error) {
	path := a.envFile
	if path != "" && !filepath.IsAbs(path) {
		path = filepath.Join(a.rootDir, path)
	}
	values, err := envfile.LoadOptional(path)
	if err != nil {
		return nil, err
	}
	for key, value := range getenvMap() {
		values[key] = value
	}
	return values, nil
}

func selectSingleAgent(cfg *config.Config, id string) (config.Agent, error) {
	agents, err := cfg.SelectAgents([]string{id})
	if err != nil {
		return config.Agent{}, err
	}
	if len(agents) != 1 {
		return config.Agent{}, fmt.Errorf("expected one agent, got %d", len(agents))
	}
	return agents[0], nil
}

func (a *app) fly() fly.Provider {
	return fly.New(a.runnerWithEnv(nil))
}

func (a *app) flyWithEnv(env map[string]string) fly.Provider {
	return fly.New(a.runnerWithEnv(env))
}

func (a *app) tailscale() tailscale.Provider {
	return tailscale.New(a.runnerWithEnv(nil))
}

func (a *app) tailscaleWithEnv(env map[string]string) tailscale.Provider {
	return tailscale.New(a.runnerWithEnv(env))
}

func (a *app) runnerWithEnv(env map[string]string) execx.Runner {
	if a.runner != nil {
		return a.runner
	}
	return execx.ShellRunner{Dir: a.rootDir, Env: env}
}

func getenvMap() map[string]string {
	values := map[string]string{}
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}
	return values
}

func updateAgentIdentityConfig(ws *workspace.Workspace, agentID, identityPath string, overwrite bool) error {
	agentPath, ok := ws.AgentFiles[agentID]
	if !ok {
		return fmt.Errorf("agent %s file not found in workspace", agentID)
	}
	data, err := os.ReadFile(agentPath)
	if err != nil {
		return err
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	agentStart, agentEnd := -1, len(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "[agent]" {
			agentStart = i
			continue
		}
		if agentStart != -1 && i > agentStart && strings.HasPrefix(trimmed, "[") {
			agentEnd = i
			break
		}
	}
	if agentStart == -1 {
		return fmt.Errorf("%s is missing [agent]", agentPath)
	}
	identityLine := fmt.Sprintf("identity = %s", tomlQuote(identityPath))
	replaced := false
	for i := agentStart + 1; i < agentEnd; i++ {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "identity = ") {
			lines[i] = identityLine
			replaced = true
			break
		}
	}
	if !replaced {
		insertAt := agentEnd
		lines = append(lines[:insertAt], append([]string{identityLine}, lines[insertAt:]...)...)
	}
	lines = updateIdentityTable(lines, overwrite)
	return os.WriteFile(agentPath, []byte(strings.Join(lines, "\n")), 0o644)
}

func updateIdentityTable(lines []string, overwrite bool) []string {
	tableStart, tableEnd := -1, len(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "[identity]" {
			tableStart = i
			continue
		}
		if tableStart != -1 && i > tableStart && strings.HasPrefix(trimmed, "[") {
			tableEnd = i
			break
		}
	}
	if tableStart == -1 {
		if overwrite {
			return lines
		}
		return append(strings.Split(strings.TrimRight(strings.Join(lines, "\n"), "\n"), "\n"),
			"",
			"[identity]",
			"enabled = true",
			"overwrite = false",
			"",
		)
	}
	updates := map[string]string{
		"enabled":   "enabled = true",
		"overwrite": fmt.Sprintf("overwrite = %t", overwrite),
	}
	seen := map[string]bool{}
	for i := tableStart + 1; i < tableEnd; i++ {
		trimmed := strings.TrimSpace(lines[i])
		for key, value := range updates {
			if strings.HasPrefix(trimmed, key+" = ") {
				lines[i] = value
				seen[key] = true
			}
		}
	}
	insertAt := tableEnd
	for _, key := range []string{"enabled", "overwrite"} {
		if !seen[key] {
			lines = append(lines[:insertAt], append([]string{updates[key]}, lines[insertAt:]...)...)
			insertAt++
		}
	}
	return lines
}

func tomlStringValue(line, key string) string {
	trimmed := strings.TrimSpace(line)
	prefix := key + " = "
	if !strings.HasPrefix(trimmed, prefix) {
		return ""
	}
	value := strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
	if len(value) < 2 || value[0] != '"' || value[len(value)-1] != '"' {
		return ""
	}
	return strings.ReplaceAll(strings.ReplaceAll(value[1:len(value)-1], `\"`, `"`), `\\`, `\`)
}

func tomlQuote(value string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`) + `"`
}

func humanNameFromID(id string) string {
	parts := strings.Split(id, "-")
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

func identityTemplate(name string) string {
	return fmt.Sprintf(`# %s Identity

You are %s, a Hermes companion agent operated by its workspace owner.

## Baseline
- Be direct, calm, and technically precise.
- Prefer useful action over generic explanation.
- State uncertainty plainly.
- Push back when the plan is weak or unsafe.

## Style
- Keep responses compact unless the task needs depth.
- Make tradeoffs explicit.
- Avoid hype, filler, and performative agreement.

## Operating Posture
- Treat code quality, observability, and reproducibility as part of the work.
- Preserve user-owned state and secrets.
`, name, name)
}
