package fly

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const DefaultAPIBaseURL = "https://api.machines.dev/v1"

type APIProvider struct {
	BaseURL string
	Token   string
	Org     string
	Client  *http.Client
}

func NewAPI(baseURL, token, org string) APIProvider {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultAPIBaseURL
	}
	return APIProvider{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, Org: org, Client: http.DefaultClient}
}

func (p APIProvider) AppExists(ctx context.Context, app string) (bool, error) {
	resp, err := p.do(ctx, http.MethodGet, "/apps/"+url.PathEscape(app), nil)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if err := require2xx(resp, "fly app read"); err != nil {
		return false, err
	}
	return true, nil
}

func (p APIProvider) CreateApp(ctx context.Context, app string) error {
	body := map[string]string{"name": app}
	if p.Org != "" {
		body["org"] = p.Org
		body["org_slug"] = p.Org
	}
	resp, err := p.do(ctx, http.MethodPost, "/apps", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return nil
	}
	return require2xx(resp, "fly app create")
}

func (p APIProvider) DeleteApp(ctx context.Context, app string) error {
	resp, err := p.do(ctx, http.MethodDelete, "/apps/"+url.PathEscape(app), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	return require2xx(resp, "fly app delete")
}

func (p APIProvider) ListVolumes(ctx context.Context, app string) ([]Volume, error) {
	resp, err := p.do(ctx, http.MethodGet, "/apps/"+url.PathEscape(app)+"/volumes", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if err := require2xx(resp, "fly volumes list"); err != nil {
		return nil, err
	}
	var wrapper struct {
		Volumes []Volume `json:"volumes"`
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return nil, nil
	}
	if err := json.Unmarshal(data, &wrapper); err == nil && strings.HasPrefix(strings.TrimSpace(string(data)), "{") {
		return wrapper.Volumes, nil
	}
	var volumes []Volume
	if err := json.Unmarshal(data, &volumes); err != nil {
		return nil, err
	}
	return volumes, nil
}

func (p APIProvider) EnsureVolume(ctx context.Context, app, name, region string, sizeGB int) (string, error) {
	volumes, err := p.ListVolumes(ctx, app)
	if err != nil {
		return "", err
	}
	selected, matches, ok := SelectVolume(volumes, name)
	if ok {
		if selected.SizeGB < sizeGB {
			resp, err := p.do(ctx, http.MethodPost, "/apps/"+url.PathEscape(app)+"/volumes/"+url.PathEscape(selected.ID)+"/extend", map[string]int{"size_gb": sizeGB})
			if err != nil {
				return "", err
			}
			defer resp.Body.Close()
			if err := require2xx(resp, "fly volume extend"); err != nil {
				return "", err
			}
			return fmt.Sprintf("~ update volume %s %s %dGB", name, selected.ID, sizeGB), nil
		}
		if len(matches) > 1 {
			return fmt.Sprintf("! drift duplicate volume %s reused %s", name, selected.ID), nil
		}
		return fmt.Sprintf("= no-op volume %s %s", name, selected.ID), nil
	}
	body := map[string]any{"name": name, "region": region, "size_gb": sizeGB}
	resp, err := p.do(ctx, http.MethodPost, "/apps/"+url.PathEscape(app)+"/volumes", body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := require2xx(resp, "fly volume create"); err != nil {
		return "", err
	}
	return fmt.Sprintf("+ create volume %s", name), nil
}

func (p APIProvider) DeleteVolume(ctx context.Context, app, volumeID string) error {
	resp, err := p.do(ctx, http.MethodDelete, "/apps/"+url.PathEscape(app)+"/volumes/"+url.PathEscape(volumeID), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	return require2xx(resp, "fly volume delete")
}

func (p APIProvider) SecretNames(ctx context.Context, app string) (map[string]bool, error) {
	resp, err := p.do(ctx, http.MethodGet, "/apps/"+url.PathEscape(app)+"/secrets", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return map[string]bool{}, nil
	}
	if err := require2xx(resp, "fly secrets list"); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		Secrets []Secret `json:"secrets"`
	}
	var secrets []Secret
	if err := json.Unmarshal(data, &wrapper); err == nil && strings.HasPrefix(strings.TrimSpace(string(data)), "{") {
		secrets = wrapper.Secrets
	} else if strings.TrimSpace(string(data)) != "" {
		if err := json.Unmarshal(data, &secrets); err != nil {
			return nil, err
		}
	}
	names := map[string]bool{}
	for _, secret := range secrets {
		if secret.Name != "" {
			names[secret.Name] = true
		}
	}
	return names, nil
}

func (p APIProvider) SetSecrets(ctx context.Context, app string, secrets map[string]string) error {
	if len(secrets) == 0 {
		return nil
	}
	resp, err := p.do(ctx, http.MethodPut, "/apps/"+url.PathEscape(app)+"/secrets", map[string]map[string]string{"secrets": secrets})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return require2xx(resp, "fly secrets set")
}

func (p APIProvider) ListMachines(ctx context.Context, app string) ([]Machine, error) {
	resp, err := p.do(ctx, http.MethodGet, "/apps/"+url.PathEscape(app)+"/machines", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if err := require2xx(resp, "fly machines list"); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		Machines []Machine `json:"machines"`
	}
	if err := json.Unmarshal(data, &wrapper); err == nil && strings.HasPrefix(strings.TrimSpace(string(data)), "{") {
		return wrapper.Machines, nil
	}
	var machines []Machine
	if strings.TrimSpace(string(data)) == "" {
		return nil, nil
	}
	if err := json.Unmarshal(data, &machines); err != nil {
		return nil, err
	}
	return machines, nil
}

func (p APIProvider) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if p.Token != "" {
		req.Header.Set("Authorization", "Bearer "+p.Token)
	}
	return p.client().Do(req)
}

func (p APIProvider) client() *http.Client {
	if p.Client != nil {
		return p.Client
	}
	return http.DefaultClient
}

func require2xx(resp *http.Response, operation string) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	message := strings.TrimSpace(string(data))
	if message == "" {
		message = resp.Status
	}
	return fmt.Errorf("%s failed: HTTP %d %s", operation, resp.StatusCode, message)
}
