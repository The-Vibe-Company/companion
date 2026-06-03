package providertest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/The-Vibe-Company/companion/internal/fly"
	"github.com/The-Vibe-Company/companion/internal/tailscale"
)

type Server struct {
	HTTP *httptest.Server

	mu                   sync.Mutex
	Apps                 map[string]*App
	TailscaleDevices     []tailscale.Device
	OpenRouterModels     []string
	FlyAuthHeaders       []string
	TailscaleAuthHeaders []string
	OpenRouterAuth       []string
	ReceivedSecretValues []string
}

type App struct {
	Name     string
	Volumes  []fly.Volume
	Secrets  map[string]bool
	Machines []fly.Machine
}

func New() *Server {
	s := &Server{
		Apps:             map[string]*App{},
		OpenRouterModels: []string{"google/gemini-3.5-flash"},
	}
	s.HTTP = httptest.NewServer(http.HandlerFunc(s.ServeHTTP))
	return s
}

func (s *Server) Close() {
	s.HTTP.Close()
}

func (s *Server) FlyBaseURL() string {
	return s.HTTP.URL + "/fly/v1"
}

func (s *Server) TailscaleBaseURL() string {
	return s.HTTP.URL + "/tailscale"
}

func (s *Server) OpenRouterBaseURL() string {
	return s.HTTP.URL + "/openrouter/api/v1"
}

func (s *Server) AddApp(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureAppLocked(name)
}

func (s *Server) AddVolume(app string, volume fly.Volume) {
	s.mu.Lock()
	defer s.mu.Unlock()
	target := s.ensureAppLocked(app)
	if volume.ID == "" {
		volume.ID = fmt.Sprintf("vol_%s_%d", strings.ReplaceAll(app, "-", "_"), len(target.Volumes)+1)
	}
	if volume.CreatedAt == "" {
		volume.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	target.Volumes = append(target.Volumes, volume)
}

func (s *Server) AddMachine(app string, machine fly.Machine) {
	s.mu.Lock()
	defer s.mu.Unlock()
	target := s.ensureAppLocked(app)
	target.Machines = append(target.Machines, machine)
}

func (s *Server) SetTailscaleDevices(devices []tailscale.Device) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.TailscaleDevices = append([]tailscale.Device(nil), devices...)
}

func (s *Server) SetOpenRouterModels(models []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.OpenRouterModels = append([]string(nil), models...)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasPrefix(r.URL.Path, "/fly/v1"):
		s.handleFly(w, r, strings.TrimPrefix(r.URL.Path, "/fly/v1"))
	case strings.HasPrefix(r.URL.Path, "/tailscale"):
		s.handleTailscale(w, r, strings.TrimPrefix(r.URL.Path, "/tailscale"))
	case strings.HasPrefix(r.URL.Path, "/openrouter/api/v1"):
		s.handleOpenRouter(w, r, strings.TrimPrefix(r.URL.Path, "/openrouter/api/v1"))
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleFly(w http.ResponseWriter, r *http.Request, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.FlyAuthHeaders = append(s.FlyAuthHeaders, r.Header.Get("Authorization"))
	parts := splitPath(path)
	if len(parts) == 1 && parts[0] == "apps" && r.Method == http.MethodPost {
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Name == "" {
			writeError(w, http.StatusBadRequest, "missing app name")
			return
		}
		if _, exists := s.Apps[body.Name]; exists {
			writeError(w, http.StatusConflict, "exists")
			return
		}
		s.ensureAppLocked(body.Name)
		writeJSON(w, http.StatusCreated, map[string]string{"name": body.Name})
		return
	}
	if len(parts) < 2 || parts[0] != "apps" {
		http.NotFound(w, r)
		return
	}
	appName := unescape(parts[1])
	app, exists := s.Apps[appName]
	if !exists {
		writeError(w, http.StatusNotFound, "app not found")
		return
	}
	if len(parts) == 2 {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]string{"name": appName})
		case http.MethodDelete:
			delete(s.Apps, appName)
			writeJSON(w, http.StatusOK, map[string]string{"deleted": appName})
		default:
			http.NotFound(w, r)
		}
		return
	}
	switch parts[2] {
	case "volumes":
		s.handleFlyVolumes(w, r, app, parts)
	case "secrets":
		s.handleFlySecrets(w, r, app)
	case "machines":
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"machines": app.Machines})
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleFlyVolumes(w http.ResponseWriter, r *http.Request, app *App, parts []string) {
	if len(parts) == 3 {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"volumes": app.Volumes})
		case http.MethodPost:
			var body struct {
				Name   string `json:"name"`
				Region string `json:"region"`
				SizeGB int    `json:"size_gb"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			volume := fly.Volume{
				ID:        fmt.Sprintf("vol_%s_%d", strings.ReplaceAll(app.Name, "-", "_"), len(app.Volumes)+1),
				Name:      body.Name,
				Region:    body.Region,
				SizeGB:    body.SizeGB,
				State:     "created",
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			}
			app.Volumes = append(app.Volumes, volume)
			writeJSON(w, http.StatusCreated, volume)
		default:
			http.NotFound(w, r)
		}
		return
	}
	if len(parts) == 5 && parts[4] == "extend" && r.Method == http.MethodPost {
		volumeID := unescape(parts[3])
		var body struct {
			SizeGB int `json:"size_gb"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for i := range app.Volumes {
			if app.Volumes[i].ID == volumeID {
				app.Volumes[i].SizeGB = body.SizeGB
				writeJSON(w, http.StatusOK, app.Volumes[i])
				return
			}
		}
		writeError(w, http.StatusNotFound, "volume not found")
		return
	}
	if len(parts) == 4 && r.Method == http.MethodDelete {
		volumeID := unescape(parts[3])
		for i := range app.Volumes {
			if app.Volumes[i].ID == volumeID {
				app.Volumes = append(app.Volumes[:i], app.Volumes[i+1:]...)
				writeJSON(w, http.StatusOK, map[string]string{"deleted": volumeID})
				return
			}
		}
		writeError(w, http.StatusNotFound, "volume not found")
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleFlySecrets(w http.ResponseWriter, r *http.Request, app *App) {
	switch r.Method {
	case http.MethodGet:
		secrets := make([]fly.Secret, 0, len(app.Secrets))
		for name := range app.Secrets {
			secrets = append(secrets, fly.Secret{Name: name, Status: "set"})
		}
		writeJSON(w, http.StatusOK, map[string]any{"secrets": secrets})
	case http.MethodPut:
		var body struct {
			Secrets map[string]string `json:"secrets"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for name, value := range body.Secrets {
			app.Secrets[name] = true
			s.ReceivedSecretValues = append(s.ReceivedSecretValues, value)
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleTailscale(w http.ResponseWriter, r *http.Request, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.TailscaleAuthHeaders = append(s.TailscaleAuthHeaders, r.Header.Get("Authorization"))
	parts := splitPath(path)
	if len(parts) == 5 && parts[0] == "api" && parts[1] == "v2" && parts[2] == "tailnet" && parts[4] == "devices" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"devices": apiDevices(s.TailscaleDevices)})
		return
	}
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "v2" && parts[2] == "device" && r.Method == http.MethodDelete {
		id := unescape(parts[3])
		for i := range s.TailscaleDevices {
			if s.TailscaleDevices[i].ID == id {
				s.TailscaleDevices = append(s.TailscaleDevices[:i], s.TailscaleDevices[i+1:]...)
				writeJSON(w, http.StatusOK, map[string]string{"deleted": id})
				return
			}
		}
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleOpenRouter(w http.ResponseWriter, r *http.Request, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.OpenRouterAuth = append(s.OpenRouterAuth, r.Header.Get("Authorization"))
	if strings.Trim(path, "/") != "models" || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	models := make([]map[string]string, 0, len(s.OpenRouterModels))
	for _, id := range s.OpenRouterModels {
		models = append(models, map[string]string{"id": id, "name": id})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": models})
}

func (s *Server) ensureAppLocked(name string) *App {
	if app, ok := s.Apps[name]; ok {
		return app
	}
	app := &App{Name: name, Secrets: map[string]bool{}}
	s.Apps[name] = app
	return app
}

func splitPath(path string) []string {
	path = strings.Trim(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

func unescape(value string) string {
	unescaped, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return unescaped
}

func apiDevices(devices []tailscale.Device) []map[string]any {
	out := make([]map[string]any, 0, len(devices))
	for _, device := range devices {
		item := map[string]any{
			"id":       device.ID,
			"hostname": device.HostName,
			"name":     device.DNSName,
			"dns_name": device.DNSName,
			"online":   device.Online,
		}
		if device.IP != "" {
			item["addresses"] = []string{device.IP}
		}
		if !device.Created.IsZero() {
			item["created"] = device.Created.Format(time.RFC3339Nano)
		}
		if !device.LastSeen.IsZero() {
			item["lastSeen"] = device.LastSeen.Format(time.RFC3339Nano)
		}
		out = append(out, item)
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	http.Error(w, message, status)
}
