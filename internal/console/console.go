// Package console implements the Companion "console" backend: an HTTP server
// that lets an operator inspect and edit the local workspace (agents, plan,
// apply, history) over a small JSON API plus an embedded UI. It is a
// local-admin tool guarded by a per-process session token, not a multi-user
// auth surface. All provider interaction is redacted to credential names and
// never performs live mutations except through the existing resource apply
// engine the CLI already uses.
package console

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/The-Vibe-Company/companion/internal/envfile"
	"github.com/The-Vibe-Company/companion/internal/execx"
	"github.com/The-Vibe-Company/companion/internal/provider"
	"github.com/The-Vibe-Company/companion/internal/state"
	"github.com/The-Vibe-Company/companion/internal/status"
	"github.com/The-Vibe-Company/companion/internal/workspace"
)

//go:embed assets
var assets embed.FS

// Sentinel markers the Vite-built (and placeholder) index.html carries verbatim.
// handleIndex replaces them with the live session token and workspace name at
// serve time. They are plain string replacements rather than Go template actions
// because the production index.html is emitted by Vite, not text/template.
const (
	tokenSentinel     = "%%CONSOLE_TOKEN%%"
	workspaceSentinel = "%%CONSOLE_WORKSPACE%%"
)

// Options configures a console Server.
type Options struct {
	// WorkspaceDir is the workspace root the console reads and edits.
	WorkspaceDir string
	// EnvFile is an optional path to a .env file. When relative it is resolved
	// against WorkspaceDir.
	EnvFile string
	// Env optionally supplies explicit environment values (tests inject these);
	// when set it overrides EnvFile loading.
	Env map[string]string
	// Runner is the command runner used for provider interactions. Tests inject
	// an execx.FakeRunner; a nil runner falls back to a real shell runner.
	Runner execx.Runner
	// Interval is the status poll interval. Zero defaults to 30s.
	Interval time.Duration
	// Clock supplies the current time for deterministic backups; nil uses
	// time.Now.
	Clock func() time.Time
	// DevUI optionally points at a dev-mode UI origin (e.g. a Vite server) to
	// reverse-proxy the root and asset routes to during development.
	DevUI string
}

// Server serves the console API and UI. It owns the session token, the apply
// operation runner, the safe TOML writer, and a cache of the most recent plan
// hash. Apply history is read per request from a store opened against the
// workspace state path.
type Server struct {
	opts  Options
	token string

	runner *OperationRunner
	writer *TomlWriter

	assets    fs.FS
	indexHTML []byte
	poller    *status.Poller

	devProxy *httputil.ReverseProxy

	mu             sync.Mutex
	latestPlanHash string

	// writeMu serializes workspace-mutating handlers (create/update/delete) so
	// their read-modify-write-validate-rollback sequences cannot interleave.
	writeMu sync.Mutex
}

// NewServer builds a console Server: it generates the session token, applies
// defaults, prepares the embedded assets and index HTML, and constructs the
// operation runner, writer, and (best-effort) history. It performs no network
// I/O.
func NewServer(opts Options) (*Server, error) {
	if opts.Interval <= 0 {
		opts.Interval = 30 * time.Second
	}
	if opts.Clock == nil {
		opts.Clock = time.Now
	}

	token, err := randomToken()
	if err != nil {
		return nil, err
	}

	staticFS, err := fs.Sub(assets, "assets")
	if err != nil {
		return nil, err
	}
	indexHTML, err := fs.ReadFile(assets, "assets/index.html")
	if err != nil {
		return nil, err
	}

	s := &Server{
		opts:      opts,
		token:     token,
		runner:    NewOperationRunner(opts.Clock),
		writer:    NewTomlWriter(opts.WorkspaceDir, opts.Clock),
		assets:    staticFS,
		indexHTML: indexHTML,
	}

	if strings.TrimSpace(opts.DevUI) != "" {
		target, err := url.Parse(opts.DevUI)
		if err != nil {
			return nil, fmt.Errorf("parse dev-ui origin: %w", err)
		}
		s.devProxy = httputil.NewSingleHostReverseProxy(target)
	}

	return s, nil
}

// Token returns the per-process session token injected into the served UI.
// Tests read it to send the X-Console-Token header on mutating requests.
func (s *Server) Token() string {
	return s.token
}

// Handler builds the console mux. It is pure: no goroutines, no network. The
// status poller is attached separately by Serve.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Read-only console API.
	mux.HandleFunc("GET /api/console/session", s.handleSession)
	mux.HandleFunc("GET /api/console/workspace", s.handleWorkspace)
	mux.HandleFunc("GET /api/console/agents", s.handleListAgents)
	mux.HandleFunc("GET /api/console/agents/{id}", s.handleGetAgent)
	mux.HandleFunc("GET /api/console/agents/{id}/logs", s.handleAgentLogs)
	mux.HandleFunc("GET /api/console/applies", s.handleListApplies)
	mux.HandleFunc("GET /api/console/operations/{id}", s.handleGetOperation)

	// Mutating console API (guarded by the session-token middleware).
	mux.HandleFunc("POST /api/console/agents", s.handleCreateAgent)
	mux.HandleFunc("PUT /api/console/agents/{id}", s.handleUpdateAgent)
	mux.HandleFunc("DELETE /api/console/agents/{id}", s.handleDeleteAgent)
	mux.HandleFunc("POST /api/console/plan", s.handlePlan)
	mux.HandleFunc("POST /api/console/apply", s.handleApply)

	// Status + health (reuse the existing snapshot contract).
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /healthz", s.handleHealthz)

	// Static UI: dev-proxy when configured, otherwise embedded assets.
	mux.HandleFunc("GET /", s.handleIndex)
	mux.Handle("GET /assets/", s.assetHandler())

	return s.withSessionToken(mux)
}

// assetHandler serves embedded static assets, or proxies to the dev UI when
// configured.
func (s *Server) assetHandler() http.Handler {
	if s.devProxy != nil {
		return s.devProxy
	}
	return staticAssetHandler(s.assets)
}

// staticAssetHandler serves the embedded SPA bundle. The embedded FS mirrors the
// Vite dist that bin/build-console-ui syncs in: an index.html beside a nested
// assets/ directory holding the hashed bundle, and the SPA requests that bundle
// at /assets/<hash>.{js,css}. Because the FS already contains the assets/
// subtree, the request path maps straight onto it. We deliberately do NOT
// StripPrefix("/assets/") here: stripping it drops the very directory that holds
// the hashed bundle, which would 404 every asset and render a blank page.
func staticAssetHandler(fsys fs.FS) http.Handler {
	return http.FileServer(http.FS(fsys))
}

// withSessionToken enforces the per-process session token on every mutating
// request (POST/PUT/DELETE) under /api/console/. Read-only GETs are exempt so
// the UI can load without a preflight.
func (s *Server) withSessionToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isMutating(r.Method) && strings.HasPrefix(r.URL.Path, "/api/console/") {
			provided := r.Header.Get("X-Console-Token")
			// Constant-time compare so a wrong token cannot be inferred by timing.
			if subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
				writeJSONError(w, http.StatusForbidden, "invalid or missing console session token")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
		return true
	default:
		return false
	}
}

// handleIndex serves the embedded console UI with the session token injected,
// or reverse-proxies to the dev UI origin when configured.
func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if s.devProxy != nil {
		s.devProxy.ServeHTTP(w, r)
		return
	}
	// Inject the live values into the embedded HTML by replacing the build-time
	// sentinels. The Vite-built index.html is not a Go template, so a literal
	// string replacement (not text/template) is what keeps both the placeholder
	// and the real built asset working.
	html := strings.ReplaceAll(string(s.indexHTML), tokenSentinel, s.token)
	html = strings.ReplaceAll(html, workspaceSentinel, filepath.Base(s.opts.WorkspaceDir))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, html)
}

// handleSession -> GET /api/console/session : returns the per-process session
// token, but ONLY in dev mode (Options.DevUI set). In dev the UI is served by
// Vite through the reverse proxy, so the token sentinels are never replaced and
// the SPA cannot read the token from the page; this endpoint is its fallback. In
// production the token is injected into the served HTML and this route 404s so
// the token is never exposed through an unauthenticated GET. It is a GET, so the
// mutating-token middleware already exempts it.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(s.opts.DevUI) == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"token": s.token})
}

// handleHealthz is a trivial liveness endpoint.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("ok"))
}

// handleStatus serves the most recent fleet status snapshot. When no poller is
// attached it returns an empty snapshot so the endpoint stays available.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var snapshot status.Snapshot
	if s.poller != nil {
		snapshot = s.poller.Snapshot()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(snapshot)
}

// Serve runs the console HTTP server with graceful shutdown, mirroring
// web.Serve. It starts a best-effort status poller goroutine: provider wiring
// errors are tolerated so the API and UI keep serving even when the fleet
// cannot be polled.
func Serve(ctx context.Context, addr string, opts Options) error {
	server, err := NewServer(opts)
	if err != nil {
		return err
	}

	if poller := server.buildPoller(opts); poller != nil {
		server.poller = poller
		go poller.Run(ctx)
	}

	httpServer := &http.Server{Addr: addr, Handler: server.Handler()}
	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		_ = httpServer.Shutdown(context.Background())
		return ctx.Err()
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

// buildPoller best-effort constructs a workspace-backed status poller. Returning
// nil (on any provider/workspace error) is acceptable: the server still serves
// the API and UI, and /api/status returns an empty snapshot. The poller derives
// the topology live from the workspace each tick, so newly created agents show
// up without a restart.
func (s *Server) buildPoller(opts Options) *status.Poller {
	ws, err := s.loadWorkspace()
	if err != nil {
		return nil
	}
	env, err := s.env()
	if err != nil {
		return nil
	}
	providers, err := provider.NewSet(ws, env, s.cmdRunner())
	if err != nil {
		return nil
	}
	flyProvider := firstFly(providers)
	tsProvider := firstTailscale(providers)
	src := status.WorkspaceSource{
		Workspace: ws.Name,
		Config:    ws.Config,
		Fly:       flyProvider,
		Tailscale: tsProvider,
	}
	return status.NewPoller(src, opts.Interval)
}

// firstFly returns a Fly provider from the set (the sole one when there is just
// one), or nil. The status poller tolerates a nil provider by skipping Fly
// machine-state enrichment.
func firstFly(set provider.Set) provider.FlyRuntime {
	for _, p := range set.Fly {
		return p
	}
	return nil
}

// firstTailscale returns a Tailscale provider from the set, or nil. A nil
// provider makes the poller skip Tailscale presence enrichment.
func firstTailscale(set provider.Set) provider.TailscaleNetwork {
	for _, p := range set.Tailscale {
		return p
	}
	return nil
}

// loadWorkspace loads the workspace fresh from disk. Every handler that needs
// current config calls this so edits made through the console are reflected
// immediately, and a reload after a write doubles as validation.
func (s *Server) loadWorkspace() (*workspace.Workspace, error) {
	return workspace.Load(s.opts.WorkspaceDir)
}

// env resolves the environment used for provider credential presence and apply.
// An explicit opts.Env wins (tests inject it for hermetic, deterministic runs);
// otherwise the optional EnvFile is loaded (resolved against WorkspaceDir). The
// console never overlays the host shell environment, keeping behavior
// reproducible; the CLI overlays shell env before constructing opts.Env.
func (s *Server) env() (map[string]string, error) {
	if s.opts.Env != nil {
		return s.opts.Env, nil
	}
	path := s.opts.EnvFile
	if path != "" && !filepath.IsAbs(path) {
		path = filepath.Join(s.opts.WorkspaceDir, path)
	}
	if path == "" {
		return map[string]string{}, nil
	}
	return envfile.LoadOptional(path)
}

// cmdRunner returns the command runner for provider interactions: the injected
// runner (an execx.FakeRunner in tests) or a real shell runner rooted at the
// workspace. It is distinct from the apply OperationRunner held in the runner
// field.
func (s *Server) cmdRunner() execx.Runner {
	if s.opts.Runner != nil {
		return s.opts.Runner
	}
	return execx.ShellRunner{Dir: s.opts.WorkspaceDir}
}

// openStore opens the workspace SQLite state store. Callers must Close it.
func (s *Server) openStore(ws *workspace.Workspace) (*state.Store, error) {
	return state.Open(ws.StatePath)
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// writeJSON encodes v as a JSON response with the given status code.
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeJSONError writes a {"error": msg} JSON body with the given status code.
func writeJSONError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// decodeJSON reads and decodes a JSON request body into v, rejecting unknown
// fields and oversized payloads.
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}
