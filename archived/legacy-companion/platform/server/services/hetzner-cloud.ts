const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

interface HetznerAction {
  id: number;
  status: "running" | "success" | "error";
  command: string;
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net?: {
    ipv4?: { ip?: string | null } | null;
  };
}

interface HetznerVolume {
  id: number;
  name: string;
  size: number;
  linux_device?: string | null;
}

interface CreateVolumeInput {
  name: string;
  size: number;
  location: string;
  labels?: Record<string, string>;
}

interface CreateServerInput {
  name: string;
  server_type: string;
  location: string;
  image: string;
  user_data?: string;
  volumes?: number[];
  ssh_keys?: string[];
  labels?: Record<string, string>;
}

export class HetznerCloudClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${HETZNER_API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hetzner API ${method} ${path} failed (${res.status}): ${text}`);
    }

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async createVolume(input: CreateVolumeInput): Promise<HetznerVolume> {
    const payload = await this.request<{ volume: HetznerVolume }>("POST", "/volumes", input);
    return payload.volume;
  }

  async deleteVolume(volumeId: string | number): Promise<void> {
    await this.request<void>("DELETE", `/volumes/${volumeId}`);
  }

  async createServer(input: CreateServerInput): Promise<{ server: HetznerServer; action?: HetznerAction }> {
    return this.request<{ server: HetznerServer; action?: HetznerAction }>("POST", "/servers", input);
  }

  async getServer(serverId: string | number): Promise<HetznerServer> {
    const payload = await this.request<{ server: HetznerServer }>("GET", `/servers/${serverId}`);
    return payload.server;
  }

  async deleteServer(serverId: string | number): Promise<void> {
    await this.request<void>("DELETE", `/servers/${serverId}`);
  }

  async powerOn(serverId: string | number): Promise<HetznerAction | undefined> {
    const payload = await this.request<{ action?: HetznerAction }>("POST", `/servers/${serverId}/actions/poweron`);
    return payload.action;
  }

  async powerOff(serverId: string | number): Promise<HetznerAction | undefined> {
    const payload = await this.request<{ action?: HetznerAction }>("POST", `/servers/${serverId}/actions/poweroff`);
    return payload.action;
  }

  async reboot(serverId: string | number): Promise<HetznerAction | undefined> {
    const payload = await this.request<{ action?: HetznerAction }>("POST", `/servers/${serverId}/actions/reboot`);
    return payload.action;
  }

  async changeType(serverId: string | number, serverType: string): Promise<HetznerAction | undefined> {
    const payload = await this.request<{ action?: HetznerAction }>(
      "POST",
      `/servers/${serverId}/actions/change_type`,
      { server_type: serverType, upgrade_disk: false },
    );
    return payload.action;
  }

  async getAction(actionId: string | number): Promise<HetznerAction> {
    const payload = await this.request<{ action: HetznerAction }>("GET", `/actions/${actionId}`);
    return payload.action;
  }

  async waitForAction(actionId: string | number, timeoutMs = 90_000): Promise<HetznerAction> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const action = await this.getAction(actionId);
      if (action.status === "success") return action;
      if (action.status === "error") {
        throw new Error(`Hetzner action ${actionId} failed (${action.command})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Hetzner action ${actionId} did not complete within ${timeoutMs}ms`);
  }

  async waitForServerStatus(serverId: string | number, status: string, timeoutMs = 90_000): Promise<HetznerServer> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const server = await this.getServer(serverId);
      if (server.status === status) return server;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Hetzner server ${serverId} did not reach status "${status}" within ${timeoutMs}ms`);
  }
}

export type { HetznerAction, HetznerServer, HetznerVolume, CreateServerInput, CreateVolumeInput };
