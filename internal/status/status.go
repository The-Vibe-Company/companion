package status

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/plan"
	"github.com/The-Vibe-Company/companion/internal/provider"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

// Health states, ordered worst-last for summary roll-ups.
const (
	HealthOK      = "ok"
	HealthDegrade = "degraded"
	HealthDown    = "down"
	HealthUnknown = "unknown"
)

// ServiceStatus is the live status of a single fleet service.
type ServiceStatus struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	FlyApp       string `json:"fly_app,omitempty"`
	Host         string `json:"host,omitempty"`
	URL          string `json:"url,omitempty"`
	Health       string `json:"health"`
	HTTPStatus   int    `json:"http_status,omitempty"`
	Online       bool   `json:"online"`
	MachineState string `json:"machine_state,omitempty"`
	Model        string `json:"model,omitempty"`
	Vault        string `json:"vault,omitempty"`
	Error        string `json:"error,omitempty"`
}

// Summary is a roll-up of service health for the dashboard header.
type Summary struct {
	Total    int `json:"total"`
	Healthy  int `json:"healthy"`
	Degraded int `json:"degraded"`
	Down     int `json:"down"`
}

// Snapshot is one full poll of the fleet.
type Snapshot struct {
	Workspace   string          `json:"workspace"`
	GeneratedAt time.Time       `json:"generated_at"`
	Services    []ServiceStatus `json:"services"`
	DriftCount  int             `json:"drift_count"`
	DriftText   string          `json:"drift_text,omitempty"`
	Summary     Summary         `json:"summary"`
}

// Collect polls every target in the topology and returns a Snapshot. It is
// tolerant of provider and network errors: a target that cannot be reached
// degrades to "unknown"/"down" rather than failing the whole snapshot. When cfg
// is non-nil and the providers are available, the drift report is included.
//
// HTTP /health probing works for every target regardless of provider. The Fly
// machine-state and Tailscale presence enrichment uses the single flyProvider /
// tsProvider passed in (the fleet's primary org + tailnet). Services that live
// in a different Fly org or tailnet still report health from their probe, but
// their machine/online columns may be empty. Multi-provider enrichment is a
// known follow-up.
func Collect(ctx context.Context, topo FleetTopology, flyProvider provider.FlyRuntime, tsProvider provider.TailscaleNetwork, cfg *config.Config) Snapshot {
	snapshot := Snapshot{
		Workspace:   topo.Workspace,
		GeneratedAt: time.Now().UTC(),
		Services:    make([]ServiceStatus, len(topo.Services)),
	}

	var devices []tailscale.Device
	if tsProvider != nil {
		if found, err := tsProvider.Devices(ctx); err == nil {
			devices = found
		}
	}

	client := &http.Client{Timeout: 5 * time.Second}
	var wg sync.WaitGroup
	for i, target := range topo.Services {
		wg.Add(1)
		go func(i int, target Target) {
			defer wg.Done()
			snapshot.Services[i] = collectTarget(ctx, client, target, devices, flyProvider)
		}(i, target)
	}
	wg.Wait()

	for _, svc := range snapshot.Services {
		snapshot.Summary.Total++
		switch svc.Health {
		case HealthOK:
			snapshot.Summary.Healthy++
		case HealthDown:
			snapshot.Summary.Down++
		default:
			snapshot.Summary.Degraded++
		}
	}

	if cfg != nil && flyProvider != nil && tsProvider != nil {
		if report, err := plan.Drift(ctx, cfg, flyProvider, tsProvider); err == nil {
			snapshot.DriftCount = len(report.Actions)
			snapshot.DriftText = report.String()
		} else {
			snapshot.DriftText = "drift check unavailable: " + err.Error()
		}
	}
	return snapshot
}

func collectTarget(ctx context.Context, client *http.Client, target Target, devices []tailscale.Device, flyProvider provider.FlyRuntime) ServiceStatus {
	svc := ServiceStatus{
		ID:     target.ID,
		Kind:   target.Kind,
		FlyApp: target.FlyApp,
		Host:   target.TailscaleHostname,
		URL:    target.HealthURL,
		Model:  target.Model,
		Vault:  target.Vault,
		Health: HealthUnknown,
	}

	// Tailscale presence.
	if len(devices) > 0 && target.TailscaleHostname != "" {
		matches := tailscale.FindByHostname(devices, target.TailscaleHostname)
		for _, device := range matches {
			if device.Online {
				svc.Online = true
				break
			}
		}
	}

	// Fly machine state (best effort).
	if flyProvider != nil && target.FlyApp != "" {
		if machines, err := flyProvider.ListMachines(ctx, target.FlyApp); err == nil {
			svc.MachineState = machineState(machines)
		}
	}

	// HTTP health probe.
	if target.HealthURL != "" {
		code, err := probe(ctx, client, target.HealthURL)
		svc.HTTPStatus = code
		switch {
		case err != nil:
			svc.Error = err.Error()
			svc.Health = HealthDown
		case code >= 200 && code < 300:
			svc.Health = HealthOK
		default:
			svc.Health = HealthDegrade
		}
		return svc
	}

	// No health endpoint: fall back to machine/tailscale signals.
	switch {
	case svc.MachineState == "stopped":
		svc.Health = HealthDown
	case svc.Online || svc.MachineState == "started":
		svc.Health = HealthOK
	default:
		svc.Health = HealthUnknown
	}
	return svc
}

func probe(ctx context.Context, client *http.Client, url string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

func machineState(machines []fly.Machine) string {
	if len(machines) == 0 {
		return ""
	}
	for _, machine := range machines {
		if machine.State == "started" {
			return "started"
		}
	}
	states := make([]string, 0, len(machines))
	for _, machine := range machines {
		if machine.State != "" {
			states = append(states, machine.State)
		}
	}
	if len(states) == 0 {
		return ""
	}
	sort.Strings(states)
	return states[0]
}

// Source produces snapshots. Local mode rebuilds the topology from the live
// workspace each poll; deployed mode uses a static manifest.
type Source interface {
	Collect(ctx context.Context) Snapshot
}

// WorkspaceSource derives the topology live from the workspace config on every
// poll, so newly added agents and re-resolved Tailscale DNS names appear
// without a restart. It also includes the drift report.
type WorkspaceSource struct {
	Workspace string
	Config    *config.Config
	Providers ProviderSummary
	Fly       provider.FlyRuntime
	Tailscale provider.TailscaleNetwork
}

func (s WorkspaceSource) Collect(ctx context.Context) Snapshot {
	var devices []tailscale.Device
	if s.Tailscale != nil {
		if found, err := s.Tailscale.Devices(ctx); err == nil {
			devices = found
		}
	}
	topo := BuildTopology(s.Workspace, s.Config, devices, s.Providers, time.Now())
	return Collect(ctx, topo, s.Fly, s.Tailscale, s.Config)
}

// ManifestSource polls a fixed topology loaded from a generated fleet.json
// manifest. Drift is skipped because the full workspace config is not present.
type ManifestSource struct {
	Topology  FleetTopology
	Fly       provider.FlyRuntime
	Tailscale provider.TailscaleNetwork
}

func (s ManifestSource) Collect(ctx context.Context) Snapshot {
	return Collect(ctx, s.Topology, s.Fly, s.Tailscale, nil)
}

// Poller refreshes a Source on an interval and caches the latest Snapshot.
type Poller struct {
	source   Source
	interval time.Duration

	mu      sync.RWMutex
	latest  Snapshot
	hasData bool
}

func NewPoller(source Source, interval time.Duration) *Poller {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Poller{source: source, interval: interval}
}

// Snapshot returns the most recent cached snapshot.
func (p *Poller) Snapshot() Snapshot {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.latest
}

// Refresh polls once, synchronously, and updates the cache.
func (p *Poller) Refresh(ctx context.Context) Snapshot {
	snapshot := p.source.Collect(ctx)
	p.mu.Lock()
	p.latest = snapshot
	p.hasData = true
	p.mu.Unlock()
	return snapshot
}

// Run polls immediately, then on the configured interval until ctx is done.
func (p *Poller) Run(ctx context.Context) {
	p.Refresh(ctx)
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.Refresh(ctx)
		}
	}
}
