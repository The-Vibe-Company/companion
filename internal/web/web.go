package web

import (
	"context"
	"html/template"
	"net/http"
	"strings"

	"github.com/The-Vibe-Company/companion/internal/config"
	"github.com/The-Vibe-Company/companion/internal/deps"
	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/plan"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

type pageData struct {
	Title       string
	Config      *config.Config
	Agent       *config.Agent
	Graph       plan.Graph
	Drift       plan.Report
	Connections []config.OpenWebUIConnection
}

func Serve(ctx context.Context, addr string, cfg *config.Config, flyProvider fly.Provider, tsProvider tailscale.Provider) error {
	mux := http.NewServeMux()
	server := &http.Server{Addr: addr, Handler: mux}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		renderPage(w, "home", pageData{Title: "Companion Fleet", Config: cfg, Connections: deps.OpenWebUIConnections(r.Context(), cfg, tsProvider)})
	})
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
	mux.HandleFunc("/drift", func(w http.ResponseWriter, r *http.Request) {
		report, err := plan.Drift(r.Context(), cfg, flyProvider, tsProvider)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		renderPage(w, "drift", pageData{Title: "Drift", Config: cfg, Drift: report})
	})

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

const layoutTemplate = `
{{define "head"}}
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{.Title}}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fa; color: #1d232b; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 18px 28px; background: #ffffff; border-bottom: 1px solid #dfe3e8; }
    nav a { color: #31516f; margin-left: 18px; text-decoration: none; font-size: 14px; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    h1 { font-size: 24px; margin: 0 0 18px; }
    h2 { font-size: 16px; margin: 24px 0 10px; }
    table { width: 100%; border-collapse: collapse; background: #ffffff; border: 1px solid #dfe3e8; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #edf0f2; text-align: left; font-size: 14px; }
    th { color: #506070; background: #fbfcfd; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .card { background: #ffffff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 14px; }
    .muted { color: #65717f; }
    code { background: #eef2f5; border-radius: 4px; padding: 2px 5px; }
    pre { white-space: pre-wrap; background: #17202a; color: #f3f6f8; border-radius: 8px; padding: 14px; overflow: auto; }
  </style>
</head>
<body>
  <header>
    <strong>Companion</strong>
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
{{define "home"}}
{{template "head" .}}
<h1>Fleet</h1>
<div class="grid">
  <div class="card"><div class="muted">Agents</div><strong>{{len .Config.Agents}}</strong></div>
  <div class="card"><div class="muted">Open WebUI</div><strong>{{if .Config.OpenWebUI.Enabled}}{{.Config.OpenWebUI.FlyApp}}{{else}}disabled{{end}}</strong></div>
  <div class="card"><div class="muted">WebUI backends</div><strong>{{len .Connections}}</strong></div>
</div>
<h2>Open WebUI Connections</h2>
<table><thead><tr><th>Agent</th><th>Model</th><th>URL</th><th>Key</th></tr></thead><tbody>
{{range .Connections}}<tr><td>{{.AgentID}}</td><td>{{.ModelName}}</td><td><code>{{.URL}}</code></td><td>{{.KeySecretName}}</td></tr>{{end}}
</tbody></table>
{{template "foot" .}}
{{end}}

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
