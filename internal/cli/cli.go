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
	"github.com/The-Vibe-Company/companion/internal/render"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
	"github.com/The-Vibe-Company/companion/internal/tailscalectl"
	"github.com/The-Vibe-Company/companion/internal/version"
	"github.com/The-Vibe-Company/companion/internal/vaultops"
	"github.com/The-Vibe-Company/companion/internal/web"
)

type app struct {
	configPath string
	statePath  string
	rootDir    string
	envFile    string
}

func NewRootCommand() *cobra.Command {
	a := &app{}
	cmd := &cobra.Command{
		Use:           "companion",
		Short:         "Manage the Companion Hermes fleet",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	cmd.PersistentFlags().StringVar(&a.configPath, "config", "companion.toml", "desired Companion config")
	cmd.PersistentFlags().StringVar(&a.statePath, "state", ".companion/state.sqlite", "observed state SQLite path")
	cmd.PersistentFlags().StringVar(&a.rootDir, "root", ".", "working root for generated artifacts")
	cmd.PersistentFlags().StringVar(&a.envFile, "env-file", ".env", "secret env file; shell variables override file values")

	cmd.AddCommand(a.importFleetCommand())
	cmd.AddCommand(a.resourceImportCommand())
	cmd.AddCommand(a.validateCommand())
	cmd.AddCommand(a.planCommand())
	cmd.AddCommand(a.applyCommand())
	cmd.AddCommand(a.applyWebUICommand())
	cmd.AddCommand(a.statusCommand())
	cmd.AddCommand(a.driftCommand())
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

func (a *app) importFleetCommand() *cobra.Command {
	var out string
	cmd := &cobra.Command{
		Use:   "import-fleet <legacy-fleet.toml>",
		Short: "Import a legacy hermes-fleet TOML into companion.toml",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			destination := out
			if destination == "" {
				destination = a.configPath
			}
			if err := config.ImportFleet(args[0], destination); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", destination)
			return nil
		},
	}
	cmd.Flags().StringVar(&out, "out", "", "destination config path")
	return cmd
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
			store, err := state.Open(a.statePath)
			if err != nil {
				return err
			}
			defer store.Close()
			resource := state.Resource{
				Provider:   address.Provider,
				Kind:       address.Kind,
				DesiredID:  address.DesiredID,
				ExternalID: externalID,
				AttrsJSON:  string(attrsJSON),
			}
			if err := store.ImportResource(cmd.Context(), resource); err != nil {
				return err
			}
			if err := store.RecordEvent(cmd.Context(), "import", address.Raw, "info", "imported resource", map[string]string{
				"provider":    address.Provider,
				"kind":        address.Kind,
				"desired_id":  address.DesiredID,
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

func (a *app) validateCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "validate",
		Short: "Validate companion.toml",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
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
				fmt.Fprintf(cmd.OutOrStdout(), "%s: ok fly_app=%s tailscale=%s dashboard=%s:%d api=%t:%d identity=%s\n", agent.ID, agent.FlyApp, agent.TailscaleHostname, agent.DashboardMode, agent.DashboardPort, agent.APIServer.Enabled, agent.APIServer.Port, identity)
			}
			if cfg.OpenWebUI.Enabled {
				ids := []string{}
				for _, connection := range cfg.OpenWebUIConnections() {
					ids = append(ids, connection.AgentID)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "%s: ok fly_app=%s tailscale=%s connections=%s\n", cfg.OpenWebUI.ID, cfg.OpenWebUI.FlyApp, cfg.OpenWebUI.TailscaleHostname, strings.Join(ids, ","))
			}
			return nil
		},
	}
}

func (a *app) planCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "plan [agent-id...]",
		Short: "Print the desired vs observed change plan",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			agents, err := cfg.SelectAgents(args)
			if err != nil {
				return err
			}
			report := plan.Build(cmd.Context(), cfg, agents, a.fly(), a.tailscale())
			fmt.Fprintln(cmd.OutOrStdout(), report.String())
			return nil
		},
	}
}

func (a *app) applyCommand() *cobra.Command {
	var reuseExistingSecrets bool
	cmd := &cobra.Command{
		Use:   "apply [agent-id...]",
		Short: "Apply one or more Companion agents",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			agents, err := cfg.SelectAgents(args)
			if err != nil {
				return err
			}
			store, err := state.Open(a.statePath)
			if err != nil {
				return err
			}
			defer store.Close()
			report := plan.Build(cmd.Context(), cfg, agents, a.fly(), a.tailscale())
			applyID, err := store.StartApply(cmd.Context(), report)
			if err != nil {
				return err
			}
			status := "failed"
			defer func() {
				_ = store.FinishApply(context.Background(), applyID, status)
			}()
			for _, agent := range agents {
				if err := a.applyAgent(cmd, store, agent, reuseExistingSecrets); err != nil {
					return err
				}
			}
			status = "succeeded"
			return nil
		},
	}
	cmd.Flags().BoolVar(&reuseExistingSecrets, "reuse-existing-secrets", false, "allow deploy when required Fly secrets already exist")
	return cmd
}

func (a *app) applyWebUICommand() *cobra.Command {
	var reuseExistingSecrets bool
	cmd := &cobra.Command{
		Use:   "apply-webui",
		Short: "Apply the shared Open WebUI frontend",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			if !cfg.OpenWebUI.Enabled {
				return fmt.Errorf("open_webui is disabled in companion.toml")
			}
			connections := deps.OpenWebUIConnections(cmd.Context(), cfg, a.tailscale())
			tomlData, err := render.OpenWebUIFlyTOML(cfg.OpenWebUI, connections)
			if err != nil {
				return err
			}
			path, err := a.writeGenerated("fly."+cfg.OpenWebUI.ID+".toml", tomlData)
			if err != nil {
				return err
			}
			store, err := state.Open(a.statePath)
			if err != nil {
				return err
			}
			defer store.Close()
			provider := a.fly()
			env, err := a.env()
			if err != nil {
				return err
			}
			values, err := openWebUISecrets(cmd.Context(), provider, cfg.OpenWebUI, connections, reuseExistingSecrets, env)
			if err != nil {
				return err
			}
			if err := provider.CreateApp(cmd.Context(), cfg.OpenWebUI.FlyApp); err != nil {
				return err
			}
			message, err := provider.EnsureVolume(cmd.Context(), cfg.OpenWebUI.FlyApp, cfg.OpenWebUI.VolumeName, cfg.OpenWebUI.Region, cfg.OpenWebUI.VolumeSizeGB)
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), message)
			printSecretsAction(cmd, cfg.OpenWebUI.FlyApp, values, reusedSecretNames(values, render.RequiredOpenWebUIFlySecrets(cfg.OpenWebUI)))
			if err := provider.SetSecrets(cmd.Context(), cfg.OpenWebUI.FlyApp, values); err != nil {
				return err
			}
			if err := provider.Deploy(cmd.Context(), cfg.OpenWebUI.FlyApp, path); err != nil {
				return err
			}
			return store.RecordEvent(cmd.Context(), "apply-webui", cfg.OpenWebUI.ID, "info", "applied open webui", map[string]string{"config": path})
		},
	}
	cmd.Flags().BoolVar(&reuseExistingSecrets, "reuse-existing-secrets", false, "allow deploy when required Fly secrets already exist")
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
			client := hermes.New()
			devices, _ := a.tailscale().Devices(cmd.Context())
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

func (a *app) driftCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "drift",
		Short: "Report observed drift",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			report := plan.Drift(cmd.Context(), cfg, a.fly(), a.tailscale())
			fmt.Fprintln(cmd.OutOrStdout(), report.String())
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
			fleetOutputs := outputs.Build(cmd.Context(), cfg, a.fly(), a.tailscale())
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
			cfg, err := a.load()
			if err != nil {
				return err
			}
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

			destination := filepath.Join(a.rootDir, filepath.FromSlash(path))
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
			if err := updateAgentIdentityConfig(a.configPath, agent.ID, path, overwrite); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", destination)
			fmt.Fprintf(cmd.OutOrStdout(), "updated %s agent=%s identity.path=%s\n", a.configPath, agent.ID, path)
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
			fmt.Fprintf(cmd.OutOrStdout(), "serving Companion dashboard at http://%s\n", addr)
			return web.Serve(cmd.Context(), addr, cfg, a.fly(), a.tailscale())
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
			result, err := vaultops.Backup(cmd.Context(), a.fly(), agent, destination, time.Now().UTC())
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
			result, err := vaultops.Restore(cmd.Context(), a.fly(), agent, args[1], time.Now().UTC())
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
			store, err := state.Open(a.statePath)
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
				if !resource.ObservedAt.IsZero() {
					observedAt = resource.ObservedAt.UTC().Format(time.RFC3339)
				}
				fmt.Fprintf(
					cmd.OutOrStdout(),
					"%s -> %s observed=%s\n",
					importer.FormatAddress(resource.Provider, resource.Kind, resource.DesiredID),
					resource.ExternalID,
					observedAt,
				)
			}
			return nil
		},
	}
}

func (a *app) applyAgent(cmd *cobra.Command, store *state.Store, agent config.Agent, reuseExistingSecrets bool) error {
	var err error
	agent, err = a.hydrateAgentIdentity(agent)
	if err != nil {
		return err
	}
	provider := a.fly()
	env, err := a.env()
	if err != nil {
		return err
	}
	secrets, reused, err := agentSecrets(cmd.Context(), provider, agent, reuseExistingSecrets, env)
	if err != nil {
		return err
	}
	tomlData, err := render.AgentFlyTOML(agent)
	if err != nil {
		return err
	}
	path, err := a.writeGenerated("fly."+agent.ID+".toml", tomlData)
	if err != nil {
		return err
	}
	if err := provider.CreateApp(cmd.Context(), agent.FlyApp); err != nil {
		return err
	}
	message, err := provider.EnsureVolume(cmd.Context(), agent.FlyApp, agent.VolumeName, agent.Region, agent.VolumeSizeGB)
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), message)
	printSecretsAction(cmd, agent.FlyApp, secrets, reused)
	if err := provider.SetSecrets(cmd.Context(), agent.FlyApp, secrets); err != nil {
		return err
	}
	if err := provider.Deploy(cmd.Context(), agent.FlyApp, path); err != nil {
		return err
	}
	return store.RecordEvent(cmd.Context(), "apply", agent.ID, "info", "applied agent", map[string]string{"config": path})
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
	cfg, err := config.Load(a.configPath)
	if err != nil {
		return nil, err
	}
	return cfg, cfg.Validate()
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
	return fly.New(execx.ShellRunner{Dir: a.rootDir})
}

func (a *app) tailscale() tailscale.Provider {
	return tailscale.New(execx.ShellRunner{Dir: a.rootDir})
}

func (a *app) generatedDir() string {
	return filepath.Join(a.rootDir, ".companion", "generated")
}

func (a *app) writeGenerated(name, contents string) (string, error) {
	dir := a.generatedDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		return "", err
	}
	return path, nil
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

func updateAgentIdentityConfig(configPath, agentID, identityPath string, overwrite bool) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(text, "\n")

	start, end := -1, len(lines)
	currentAgentStart := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "[[agents]]" {
			if start != -1 {
				end = i
				break
			}
			currentAgentStart = i
			continue
		}
		if currentAgentStart == -1 {
			continue
		}
		if tomlStringValue(line, "id") == agentID {
			start = currentAgentStart
		}
	}
	if start == -1 {
		return fmt.Errorf("agent %s not found in %s", agentID, configPath)
	}

	block := append([]string(nil), lines[start:end]...)
	identityStart, identityEnd := -1, len(block)
	for i, line := range block {
		trimmed := strings.TrimSpace(line)
		if trimmed == "[agents.identity]" {
			identityStart = i
			continue
		}
		if identityStart != -1 && i > identityStart && strings.HasPrefix(trimmed, "[") {
			identityEnd = i
			break
		}
	}

	replacement := []string{
		"",
		"[agents.identity]",
		"enabled = true",
		fmt.Sprintf("path = %s", tomlQuote(identityPath)),
		fmt.Sprintf("overwrite = %t", overwrite),
	}

	if identityStart != -1 {
		if identityStart > 0 && strings.TrimSpace(block[identityStart-1]) == "" {
			identityStart--
		}
		block = append(block[:identityStart], append(replacement, block[identityEnd:]...)...)
	} else {
		insertAt := len(block)
		for insertAt > 0 && strings.TrimSpace(block[insertAt-1]) == "" {
			insertAt--
		}
		block = append(block[:insertAt], append(replacement, block[insertAt:]...)...)
	}

	lines = append(lines[:start], append(block, lines[end:]...)...)
	return os.WriteFile(configPath, []byte(strings.Join(lines, "\n")), 0o644)
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

You are %s, a Hermes companion agent operated by The Vibe Company.

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
