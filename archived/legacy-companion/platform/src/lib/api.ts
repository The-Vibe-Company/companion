/**
 * REST client for the Companion Cloud control plane API.
 */

import type { ProvisioningStep } from "./types";

const BASE = "/api";

export interface ProvisioningRegion {
  value: string;
  label: string;
}

export interface ControlPlaneStatus {
  service: string;
  version: string;
  status: string;
  provisioning?: {
    provider?: "hetzner";
    regions?: ProvisioningRegion[];
  };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${method} ${path} failed (${res.status}): ${errText}`);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Create an instance with real-time progress streaming via SSE.
 * Follows the same pattern as web/src/api.ts createSessionStream.
 */
async function createInstanceStream(
  data: {
    plan: string;
    region: string;
    ownerType?: "shared" | "personal";
  },
  onProgress: (step: ProvisioningStep) => void,
): Promise<{ instance: unknown }> {
  const res = await fetch(`${BASE}/instances/create-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { instance: unknown } | null = null;
  let streamError: Error | null = null;

  while (true) {
    const { done, value } = await reader.read();
    // Flush the decoder on stream end (handles buffered multi-byte sequences),
    // otherwise decode the incoming chunk in streaming mode.
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

    // Parse SSE events with support for LF and CRLF line endings.
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let eventType = "";
      let eventData = "";
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) eventData = line.slice(5).trim();
      }
      if (!eventData) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(eventData);
      } catch {
        continue; // Skip malformed SSE data
      }
      if (eventType === "progress") {
        onProgress(parsed as ProvisioningStep);
      } else if (eventType === "done") {
        result = parsed as { instance: unknown };
        await reader.cancel();
        break;
      } else if (eventType === "error") {
        streamError = new Error((parsed as { error: string }).error || "Instance creation failed");
        await reader.cancel();
        break;
      }
    }

    if (streamError) throw streamError;
    if (result) return result;
    if (done) break;
  }

  if (!result) {
    throw new Error("Stream ended without instance creation result");
  }

  return result;
}

export const api = {
  // Instances
  listInstances: () => request<{ instances: unknown[] }>("GET", "/instances"),
  createInstance: (data: {
    plan: string;
    region: string;
    ownerType?: "shared" | "personal";
  }) => request("POST", "/instances", data),
  createInstanceStream,
  getInstance: (id: string) => request("GET", `/instances/${id}`),
  deleteInstance: (id: string) => request("DELETE", `/instances/${id}`),
  startInstance: (id: string) => request("POST", `/instances/${id}/start`),
  stopInstance: (id: string) => request("POST", `/instances/${id}/stop`),
  restartInstance: (id: string) => request("POST", `/instances/${id}/restart`),
  getInstanceToken: (id: string) => request("POST", `/instances/${id}/token`),

  // Billing
  createCheckout: (plan: string) =>
    request<{ url: string }>("POST", "/billing/checkout", { plan }),
  getBillingPortal: () => request<{ url: string }>("POST", "/billing/portal"),

  // Dashboard
  getUsage: () => request("GET", "/dashboard/usage"),

  // Status
  getStatus: () => request<ControlPlaneStatus>("GET", "/status"),
};
