package hermes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	HTTPClient *http.Client
}

type Health struct {
	URL    string
	OK     bool
	Status int
	Error  string
}

type Models struct {
	URL   string
	IDs   []string
	Error string
}

func New() Client {
	return Client{HTTPClient: &http.Client{Timeout: 8 * time.Second}}
}

func (c Client) Health(ctx context.Context, baseURL string) Health {
	url := strings.TrimRight(baseURL, "/") + "/health"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Health{URL: url, Error: err.Error()}
	}
	resp, err := c.http().Do(req)
	if err != nil {
		return Health{URL: url, Error: err.Error()}
	}
	defer resp.Body.Close()
	return Health{URL: url, OK: resp.StatusCode >= 200 && resp.StatusCode < 300, Status: resp.StatusCode}
}

func (c Client) Models(ctx context.Context, baseURL, key string) Models {
	url := strings.TrimRight(baseURL, "/") + "/v1/models"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Models{URL: url, Error: err.Error()}
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := c.http().Do(req)
	if err != nil {
		return Models{URL: url, Error: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Models{URL: url, Error: fmt.Sprintf("http %d", resp.StatusCode)}
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return Models{URL: url, Error: err.Error()}
	}
	var ids []string
	for _, model := range payload.Data {
		ids = append(ids, model.ID)
	}
	return Models{URL: url, IDs: ids}
}

func (c Client) http() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 8 * time.Second}
}
