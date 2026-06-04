package console

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/The-Vibe-Company/companion/internal/config"
)

// agentTOMLFile mirrors the per-file shape an agents/<id>.toml unmarshals into
// (see internal/workspace.agentFile). The console marshals this struct back to
// TOML via pelletier/go-toml/v2 so round-trips stay valid for workspace.Load.
//
// Sub-tables use the config.Raw* layer (pointer fields) so unset optional keys
// are omitted entirely: an all-nil Raw struct marshals to nothing under the
// `omitempty` tag, keeping generated files minimal and faithful.
//
// The struct mirrors workspace.agentFile field-for-field (including the dual
// vault-connection spellings the loader accepts) so an unmarshal -> mutate ->
// marshal round-trip preserves EVERY key Companion understands. That fidelity is
// what makes update and delete non-destructive for hand-authored files that use
// fields the console form does not surface.
type agentTOMLFile struct {
	Agent            agentTOMLTable              `toml:"agent"`
	Model            config.RawModel             `toml:"model,omitempty"`
	APIServer        config.RawAPIServer         `toml:"api_server,omitempty"`
	DefaultVault     config.RawDefaultVault      `toml:"default_vault,omitempty"`
	Identity         config.RawIdentity          `toml:"identity,omitempty"`
	CompanionSoul    config.RawCompanionSoul     `toml:"companion_soul,omitempty"`
	VaultConnections []config.RawVaultConnection `toml:"vault_connections,omitempty"`
	// VaultConnectionsAlt captures the singular `[[vault_connection]]` spelling
	// the loader also accepts, so neither form is dropped on round-trip.
	VaultConnectionsAlt []config.RawVaultConnection `toml:"vault_connection,omitempty"`
}

// agentTOMLTable is the [agent] table. It mirrors workspace.rawAgentTable in full
// (pointer fields so unset keys stay omitted) so that reading an existing agent
// file and writing it back preserves every [agent] key — not just the handful
// the console form edits. IdentityPath maps to the `identity = "..."` shorthand
// the workspace loader promotes into the [identity] table.
type agentTOMLTable struct {
	ID                         *string `toml:"id"`
	Runtime                    *string `toml:"runtime,omitempty"`
	Network                    *string `toml:"network,omitempty"`
	ModelProvider              *string `toml:"model_provider,omitempty"`
	Lifecycle                  *string `toml:"lifecycle,omitempty"`
	Protect                    *bool   `toml:"protect,omitempty"`
	FlyApp                     *string `toml:"fly_app,omitempty"`
	TailscaleHostname          *string `toml:"tailscale_hostname,omitempty"`
	IdentityPath               *string `toml:"identity,omitempty"`
	Region                     *string `toml:"region,omitempty"`
	VolumeName                 *string `toml:"volume_name,omitempty"`
	VolumeSizeGB               *int    `toml:"volume_size_gb,omitempty"`
	Memory                     *string `toml:"memory,omitempty"`
	CPUs                       *int    `toml:"cpus,omitempty"`
	DashboardMode              *string `toml:"dashboard_mode,omitempty"`
	DashboardHost              *string `toml:"dashboard_host,omitempty"`
	DashboardInsecure          *bool   `toml:"dashboard_insecure,omitempty"`
	DashboardPort              *int    `toml:"dashboard_port,omitempty"`
	GraniteEnabled             *bool   `toml:"granite_enabled,omitempty"`
	TailscaleAuthKeySecretName *string `toml:"tailscale_authkey_secret_name,omitempty"`
	TailscaleAcceptDNS         *bool   `toml:"tailscale_accept_dns,omitempty"`
	TSExtraArgs                *string `toml:"ts_extra_args,omitempty"`
	TailscaledExtraArgs        *string `toml:"tailscaled_extra_args,omitempty"`
	GraniteTemplate            *string `toml:"granite_template,omitempty"`
}

// Console-managed defaults mirror examples/minimal so a freshly created agent
// loads and plans without further editing.
const (
	defaultRuntime       = "fly.default"
	defaultNetwork       = "tailscale.default"
	defaultModelProvider = "openrouter.default"
	defaultLifecycle     = "present"
)

// soulRelPath is the workspace-relative SOUL.md path for an agent identity. It
// is written into [agent].identity so apply renders the agent SOUL.
func soulRelPath(id string) string {
	return path("identities", id, "SOUL.md")
}

// path joins workspace-relative segments with forward slashes (TOML/path form),
// independent of the host separator.
func path(segments ...string) string {
	return strings.Join(segments, "/")
}

// TomlWriter performs safe, backup-protected writes of console-managed files
// (agents/<id>.toml and identities/<id>/SOUL.md) under a workspace root. Before
// overwriting an existing file it copies the current contents into a timestamped
// backup directory derived from clock.
type TomlWriter struct {
	root  string
	clock func() time.Time
}

// NewTomlWriter builds a writer rooted at the workspace directory. A nil clock
// defaults to time.Now.
func NewTomlWriter(root string, clock func() time.Time) *TomlWriter {
	if clock == nil {
		clock = time.Now
	}
	return &TomlWriter{root: root, clock: clock}
}

// AgentPath returns the absolute path to agents/<id>.toml under the workspace.
func (w *TomlWriter) AgentPath(id string) string {
	return filepath.Join(w.root, "agents", id+".toml")
}

// SoulPath returns the absolute path to identities/<id>/SOUL.md under the
// workspace.
func (w *TomlWriter) SoulPath(id string) string {
	return filepath.Join(w.root, "identities", id, "SOUL.md")
}

// BuildAgentFile converts an AgentInput into a fresh per-file TOML struct for a
// NEW agent, applying console defaults (mirroring examples/minimal) for omitted
// optional fields. It does not touch the filesystem.
func (w *TomlWriter) BuildAgentFile(in AgentInput) (agentTOMLFile, error) {
	var file agentTOMLFile
	if err := applyInput(&file, in); err != nil {
		return agentTOMLFile{}, err
	}
	return file, nil
}

// MergeAgentFile loads the existing agents/<id>.toml and overlays the AgentInput
// projection onto it, PRESERVING every field the console form does not model —
// volume sizing, dashboard/granite settings, secret-name references, [api_server],
// [[vault_connections]], and any other [agent] key. This is the update path: the
// structured form edits the fields it shows without discarding the rest of a
// hand-authored file. The id is authoritative (callers pass the path id).
func (w *TomlWriter) MergeAgentFile(id string, in AgentInput) (agentTOMLFile, error) {
	if err := validateID(id); err != nil {
		return agentTOMLFile{}, err
	}
	data, err := os.ReadFile(w.AgentPath(id))
	if err != nil {
		return agentTOMLFile{}, fmt.Errorf("read agent %s: %w", id, err)
	}
	var file agentTOMLFile
	if err := toml.Unmarshal(data, &file); err != nil {
		return agentTOMLFile{}, fmt.Errorf("parse agent %s: %w", id, err)
	}
	in.ID = id
	if err := applyInput(&file, in); err != nil {
		return agentTOMLFile{}, err
	}
	return file, nil
}

// applyInput overlays the structured AgentInput fields onto file in place. Core
// fields fall back to the file's current value, then to the console default, so
// the overlay is correct for both a fresh struct (create) and an existing one
// (update). Optional fields are applied only when provided, so an update never
// wipes a field the form left blank. Name-shaped fields are validated by reusing
// config.Normalize, so the writer rejects exactly what workspace.Load would.
func applyInput(file *agentTOMLFile, in AgentInput) error {
	id := strings.TrimSpace(in.ID)
	if err := validateID(id); err != nil {
		return err
	}

	runtime := firstNonEmpty(in.Runtime, ptrVal(file.Agent.Runtime), defaultRuntime)
	network := firstNonEmpty(in.Network, ptrVal(file.Agent.Network), defaultNetwork)
	modelProvider := firstNonEmpty(in.ModelProvider, ptrVal(file.Agent.ModelProvider), defaultModelProvider)
	lifecycle := firstNonEmpty(in.Lifecycle, ptrVal(file.Agent.Lifecycle), defaultLifecycle)
	flyApp := firstNonEmpty(in.FlyApp, ptrVal(file.Agent.FlyApp), id)
	tailscaleHostname := firstNonEmpty(in.TailscaleHostname, ptrVal(file.Agent.TailscaleHostname), id)

	if err := validateAgentNames(id, flyApp, tailscaleHostname, runtime, network, modelProvider, lifecycle); err != nil {
		return err
	}

	file.Agent.ID = strPtr(id)
	file.Agent.Runtime = strPtr(runtime)
	file.Agent.Network = strPtr(network)
	file.Agent.ModelProvider = strPtr(modelProvider)
	file.Agent.Lifecycle = strPtr(lifecycle)
	file.Agent.FlyApp = strPtr(flyApp)
	file.Agent.TailscaleHostname = strPtr(tailscaleHostname)

	if v := strings.TrimSpace(in.Region); v != "" {
		file.Agent.Region = strPtr(v)
	}
	if v := strings.TrimSpace(in.Memory); v != "" {
		file.Agent.Memory = strPtr(v)
	}
	if in.CPUs > 0 {
		file.Agent.CPUs = intPtr(in.CPUs)
	}

	// Model: a chosen model goes into [model].default. Mirroring examples/minimal,
	// the workspace defaults.toml already enables the model + provider, so the
	// agent file only needs to override the model name when one is supplied.
	if v := strings.TrimSpace(in.Model); v != "" {
		file.Model.Default = strPtr(v)
	}

	// default_vault.name carries the human label the UI edits.
	if v := strings.TrimSpace(in.VaultName); v != "" {
		file.DefaultVault.Name = strPtr(v)
	}

	// A provided soul is written to identities/<id>/SOUL.md and referenced via the
	// [agent].identity shorthand (promoted to identity.path + enabled on load).
	if strings.TrimSpace(in.Soul) != "" {
		file.Agent.IdentityPath = strPtr(soulRelPath(id))
	}

	// companion_soul toggles the fleet-wide SOUL addition for this agent.
	if in.CompanionSoulEnabled != nil {
		file.CompanionSoul.Enabled = boolPtr(*in.CompanionSoulEnabled)
	}

	return nil
}

// WriteAgent marshals the agent file to agents/<id>.toml, backing up any
// existing file first. It returns the backup directory used (empty when the
// target did not previously exist) so the API layer can roll back.
func (w *TomlWriter) WriteAgent(id string, file agentTOMLFile) (backupDir string, err error) {
	if err := validateID(id); err != nil {
		return "", err
	}
	data, err := toml.Marshal(file)
	if err != nil {
		return "", fmt.Errorf("marshal agent %s: %w", id, err)
	}
	return w.writeFile(w.AgentPath(id), data)
}

// WriteSoul writes identities/<id>/SOUL.md, backing up any existing file first.
// It returns the backup directory used (empty when the target did not previously
// exist).
func (w *TomlWriter) WriteSoul(id, soul string) (backupDir string, err error) {
	if err := validateID(id); err != nil {
		return "", err
	}
	content := strings.TrimRight(soul, "\n") + "\n"
	return w.writeFile(w.SoulPath(id), []byte(content))
}

// SetLifecycleAbsent implements console DELETE semantics: it reads the existing
// agents/<id>.toml, sets [agent].lifecycle = "absent", and rewrites it (with a
// backup) WITHOUT removing the file. The agent stays in the workspace so plan
// renders an explicit destroy. It returns the backup directory used.
func (w *TomlWriter) SetLifecycleAbsent(id string) (backupDir string, err error) {
	if err := validateID(id); err != nil {
		return "", err
	}
	target := w.AgentPath(id)
	data, err := os.ReadFile(target)
	if err != nil {
		return "", fmt.Errorf("read agent %s: %w", id, err)
	}
	var file agentTOMLFile
	if err := toml.Unmarshal(data, &file); err != nil {
		return "", fmt.Errorf("parse agent %s: %w", id, err)
	}
	absent := "absent"
	file.Agent.Lifecycle = &absent
	out, err := toml.Marshal(file)
	if err != nil {
		return "", fmt.Errorf("marshal agent %s: %w", id, err)
	}
	return w.writeFile(target, out)
}

// Restore copies the files saved under backupDir back into the workspace,
// overwriting current contents. It is used by the API layer to roll back a write
// that failed post-write validation. A blank backupDir is a no-op.
func (w *TomlWriter) Restore(backupDir string) error {
	if strings.TrimSpace(backupDir) == "" {
		return nil
	}
	return filepath.Walk(backupDir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(backupDir, p)
		if err != nil {
			return err
		}
		dest := filepath.Join(w.root, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0o644)
	})
}

// RemoveAgent deletes agents/<id>.toml. It is used by the API layer to roll back
// a freshly created agent file (one with no prior backup). Missing files are
// tolerated.
func (w *TomlWriter) RemoveAgent(id string) error {
	if err := validateID(id); err != nil {
		return err
	}
	if err := os.Remove(w.AgentPath(id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// RemoveSoul deletes identities/<id>/SOUL.md and, when it becomes empty, the
// identities/<id>/ directory. It rolls back a SOUL.md freshly written for a
// create that then failed validation (one with no prior backup to restore).
// Missing files are tolerated.
func (w *TomlWriter) RemoveSoul(id string) error {
	if err := validateID(id); err != nil {
		return err
	}
	soul := w.SoulPath(id)
	if err := os.Remove(soul); err != nil && !os.IsNotExist(err) {
		return err
	}
	// Best-effort: drop the now-empty identities/<id>/ directory. A non-empty
	// directory makes os.Remove fail, which we intentionally ignore.
	_ = os.Remove(filepath.Dir(soul))
	return nil
}

// writeFile writes data to target, first backing up any existing file into a
// timestamped backup dir under <root>/.companion/backups/<ts>/<relpath>. The
// returned backupDir is empty when the target did not previously exist.
func (w *TomlWriter) writeFile(target string, data []byte) (string, error) {
	backupDir, err := w.backup(target)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", err
	}
	return backupDir, nil
}

// backup copies target into <root>/.companion/backups/<ts>/<relpath> when it
// exists, returning the backup directory (the <ts> root). It returns "" when the
// target does not exist (nothing to back up).
func (w *TomlWriter) backup(target string) (string, error) {
	if _, err := os.Stat(target); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	rel, err := filepath.Rel(w.root, target)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("refusing to back up path outside workspace: %s", target)
	}
	ts := backupStamp(w.clock())
	backupDir := filepath.Join(w.root, ".companion", "backups", ts)
	dest := filepath.Join(backupDir, rel)
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return "", err
	}
	return backupDir, nil
}

// backupStamp renders a filesystem-safe, sortable timestamp for backup dir
// names. It is derived from the injected clock so tests get deterministic paths.
func backupStamp(t time.Time) string {
	return t.UTC().Format("20060102T150405.000000000Z")
}

// validateID rejects empty ids and any id that could escape the workspace via
// path traversal or separators, then defers cosmetic name rules to config.
func validateID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("agent id is required")
	}
	if id == "." || id == ".." || strings.ContainsAny(id, `/\`) || strings.Contains(id, "..") {
		return fmt.Errorf("invalid agent id %q: path traversal not allowed", id)
	}
	return nil
}

// validateAgentNames reuses the config package's validation by normalizing a
// minimal one-agent config. Any name/shape error config.Validate would raise for
// id, fly_app, or tailscale_hostname surfaces here, so the writer never produces
// a file the loader would reject for those fields.
func validateAgentNames(id, flyApp, tailscaleHostname, runtime, network, modelProvider, lifecycle string) error {
	raw := config.RawConfig{
		Agents: []config.RawAgent{{
			ID:                strPtr(id),
			FlyApp:            strPtr(flyApp),
			TailscaleHostname: strPtr(tailscaleHostname),
			Runtime:           strPtr(runtime),
			Network:           strPtr(network),
			ModelProvider:     strPtr(modelProvider),
			Lifecycle:         strPtr(lifecycle),
		}},
	}
	if _, err := config.Normalize(raw); err != nil {
		return err
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func strPtr(v string) *string { return &v }
func boolPtr(v bool) *bool    { return &v }
func intPtr(v int) *int       { return &v }

// ptrVal dereferences a *string, returning "" for nil. Used by applyInput to
// fall back to a file's existing value when the input omits a field.
func ptrVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
