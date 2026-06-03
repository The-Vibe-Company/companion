package web

import (
	"context"
	"embed"
	"encoding/json"
	"html/template"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/deps"
	"github.com/The-Vibe-Company/companion/internal/plan"
	"github.com/The-Vibe-Company/companion/internal/provider"
	"github.com/The-Vibe-Company/companion/internal/status"
)

//go:embed assets
var assets embed.FS

type pageData struct {
	Title       string
	Config      *config.Config
	Agent       *config.Agent
	Graph       plan.Graph
	Drift       plan.Report
	Connections []config.OpenWebUIConnection
}

// Serve runs the dashboard HTTP server. It starts a background poller from the
// given status source (workspace-derived locally, manifest-derived when
// deployed) and serves a polished status UI plus a JSON API. The cfg/fly/ts
// arguments power the legacy server-rendered pages and may be nil in deployed
// mode, in which case those routes are disabled.
func Serve(ctx context.Context, addr string, src status.Source, interval time.Duration, cfg *config.Config, flyProvider provider.FlyRuntime, tsProvider provider.TailscaleNetwork) error {
	poller := status.NewPoller(src, interval)
	go poller.Run(ctx)

	mux := http.NewServeMux()
	server := &http.Server{Addr: addr, Handler: mux}

	staticFS, err := fs.Sub(assets, "assets")
	if err != nil {
		return err
	}

	indexTpl, err := template.ParseFS(assets, "assets/index.html")
	if err != nil {
		return err
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		snapshot := poller.Snapshot()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = indexTpl.Execute(w, map[string]any{
			"Workspace":   snapshot.Workspace,
			"IntervalSec": int(interval.Seconds()),
		})
	})

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		snapshot := poller.Snapshot()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(snapshot)
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})

	mux.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(staticFS))))

	// Legacy server-rendered pages (parity with documented routes). Disabled
	// when the workspace config is not present (deployed manifest mode).
	if cfg != nil {
		mux.HandleFunc("/agents", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/agents" {
				agentID := strings.TrimPrefix(r.URL.Path, "/agents/")
				for _, agent := range cfg.Agents {
					if agent.ID == agentID {
						selected := agent
						renderPage(w, "agent", pageData{Title: agent.ID, Config: cfg, Agent: &selected})
						return
					}
				}
				http.NotFound(w, r)
				return
			}
			renderPage(w, "agents", pageData{Title: "Agents", Config: cfg})
		})
		mux.HandleFunc("/graph", func(w http.ResponseWriter, r *http.Request) {
			graph := plan.BuildGraph(cfg)
			if r.URL.Query().Get("format") == "json" || strings.Contains(r.Header.Get("Accept"), "application/json") {
				data, err := graph.JSON()
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(data)
				return
			}
			renderPage(w, "graph", pageData{Title: "Graph", Config: cfg, Graph: graph})
		})
		if flyProvider != nil && tsProvider != nil {
			mux.HandleFunc("/drift", func(w http.ResponseWriter, r *http.Request) {
				report, err := plan.Drift(r.Context(), cfg, flyProvider, tsProvider)
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadGateway)
					return
				}
				renderPage(w, "drift", pageData{Title: "Drift", Config: cfg, Drift: report})
			})
		}
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		_ = server.Shutdown(context.Background())
		return ctx.Err()
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func renderPage(w http.ResponseWriter, name string, data pageData) {
	tpl := template.Must(template.New("layout").Parse(layoutTemplate + pageTemplates))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tpl.ExecuteTemplate(w, name, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// keep deps import meaningful for legacy connection rendering helpers
var _ = deps.OpenWebUIConnections

const layoutTemplate = `
{{define "head"}}
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{.Title}} · Companion</title>
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body class="legacy">
  <header class="topbar">
    <a class="brand" href="/">Companion</a>
    <nav>
      <a href="/">Fleet</a>
      <a href="/agents">Agents</a>
      <a href="/graph">Graph</a>
      <a href="/drift">Drift</a>
    </nav>
  </header>
  <main>
{{end}}
{{define "foot"}}
  </main>
</body>
</html>
{{end}}
`

const pageTemplates = `
{{define "agents"}}
{{template "head" .}}
<h1>Agents</h1>
<table><thead><tr><th>ID</th><th>Fly app</th><th>Tailscale</th><th>Model</th><th>Vault</th><th>API</th></tr></thead><tbody>
{{range .Config.Agents}}
<tr><td><a href="/agents/{{.ID}}">{{.ID}}</a></td><td>{{.FlyApp}}</td><td>{{.TailscaleHostname}}</td><td>{{.Model.Default}}</td><td>{{.DefaultVault.Name}}</td><td>{{if .APIServer.Enabled}}:{{.APIServer.Port}}{{else}}off{{end}}</td></tr>
{{end}}
</tbody></table>
{{template "foot" .}}
{{end}}

{{define "agent"}}
{{template "head" .}}
<h1>{{.Agent.ID}}</h1>
<div class="grid">
  <div class="card"><div class="muted">Fly app</div><strong>{{.Agent.FlyApp}}</strong></div>
  <div class="card"><div class="muted">Tailscale</div><strong>{{.Agent.TailscaleHostname}}</strong></div>
  <div class="card"><div class="muted">Model</div><strong>{{.Agent.Model.Default}}</strong></div>
  <div class="card"><div class="muted">Vault</div><strong>{{.Agent.DefaultVault.Name}}</strong></div>
</div>
<h2>Vault Connections</h2>
<table><thead><tr><th>Name</th><th>Mode</th><th>Role</th><th>MCP</th></tr></thead><tbody>
{{range .Agent.VaultConnections}}<tr><td>{{.Name}}</td><td>{{.Mode}}</td><td>{{.Role}}</td><td>{{.MCPName}}</td></tr>{{end}}
</tbody></table>
{{template "foot" .}}
{{end}}

{{define "graph"}}
{{template "head" .}}
<h1>Graph</h1>
<pre>{{.Graph.Text}}</pre>
{{template "foot" .}}
{{end}}

{{define "drift"}}
{{template "head" .}}
<h1>Drift</h1>
<pre>{{.Drift.String}}</pre>
{{template "foot" .}}
{{end}}
`
