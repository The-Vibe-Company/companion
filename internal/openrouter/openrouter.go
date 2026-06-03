package openrouter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const DefaultBaseURL = "https://openrouter.ai/api/v1"

type Client struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func New(baseURL, apiKey string) Client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultBaseURL
	}
	return Client{BaseURL: strings.TrimRight(baseURL, "/"), APIKey: apiKey, Client: http.DefaultClient}
}

func (c Client) Models(ctx context.Context) ([]Model, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/models", nil)
	if err != nil {
		return nil, err
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(data))
		if message == "" {
			message = resp.Status
		}
		return nil, fmt.Errorf("openrouter models list failed: HTTP %d %s", resp.StatusCode, message)
	}
	var payload struct {
		Data []Model `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Data, nil
}

func (c Client) HasModel(ctx context.Context, id string) (bool, error) {
	models, err := c.Models(ctx)
	if err != nil {
		return false, err
	}
	for _, model := range models {
		if model.ID == id {
			return true, nil
		}
	}
	return false, nil
}

func (c Client) client() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return http.DefaultClient
}
