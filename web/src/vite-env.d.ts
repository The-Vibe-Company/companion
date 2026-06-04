/// <reference types="vite/client" />

// The Go console injects the per-process session token into the served HTML.
// In production it is available on the window; in dev the API client falls back
// to the `GET /api/console/session` endpoint.
interface Window {
  __CONSOLE_TOKEN__?: string;
}
