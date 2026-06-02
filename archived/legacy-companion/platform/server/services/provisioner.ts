import { randomBytes } from "node:crypto";
import { HetznerCloudClient } from "./hetzner-cloud.js";

const PLAN_CONFIGS = {
  starter: { storage_gb: 10 },
  pro: { storage_gb: 50 },
  enterprise: { storage_gb: 100 },
} as const;

export type Plan = keyof typeof PLAN_CONFIGS;
export type ProvisionProgressFn = (step: string, label: string, status: "in_progress" | "done" | "error") => void;

interface ProvisionInput {
  organizationId: string;
  plan: Plan;
  region: string;
  hostname: string;
  loginUrl: string;
  tailscaleAuthKey?: string;
  onProgress?: ProvisionProgressFn;
}

interface ProvisionResult {
  providerMachineId: string;
  providerVolumeId: string;
  authSecret: string;
  hostname: string;
}

interface ProvisionerConfig {
  hetznerToken: string;
  companionImage: string;
  hetznerSshKeyId?: string;
  hetznerServerTypes?: Partial<Record<Plan, string>>;
}

const DEFAULT_SERVER_TYPE_CANDIDATES: Record<Plan, string[]> = {
  starter: ["cpx11", "cpx22", "cx23"],
  pro: ["cpx21", "cpx32", "cx33"],
  enterprise: ["cpx31", "cpx42", "cx43"],
};

const EUROPE_SERVER_TYPE_CANDIDATES: Record<Plan, string[]> = {
  starter: ["cpx22", "cx23", "cpx11"],
  pro: ["cpx32", "cx33", "cpx21"],
  enterprise: ["cpx42", "cx43", "cpx31"],
};

function makeVolumeName(hostname: string, suffixSeed: string): string {
  const safe = hostname
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = (safe || "instance").slice(0, 20);
  return `companion_${suffix}_${suffixSeed}`;
}

function makeMachineName(hostname: string, suffixSeed: string): string {
  const safe = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = (safe || "instance").slice(0, 32);
  return `companion-${suffix}-${suffixSeed}`;
}

function sanitizeCloudInitValue(value: string | undefined): string {
  return String(value || "").replace(/[\r\n]/g, "").trim();
}

export class Provisioner {
  private hetzner: HetznerCloudClient;
  private companionImage: string;
  private hetznerSshKeyId?: string;
  private hetznerServerTypes: Record<Plan, string>;

  constructor(config: ProvisionerConfig) {
    this.hetzner = new HetznerCloudClient(config.hetznerToken);
    this.companionImage = config.companionImage;
    this.hetznerSshKeyId = config.hetznerSshKeyId;
    this.hetznerServerTypes = {
      starter: config.hetznerServerTypes?.starter || DEFAULT_SERVER_TYPE_CANDIDATES.starter[0],
      pro: config.hetznerServerTypes?.pro || DEFAULT_SERVER_TYPE_CANDIDATES.pro[0],
      enterprise: config.hetznerServerTypes?.enterprise || DEFAULT_SERVER_TYPE_CANDIDATES.enterprise[0],
    };
  }

  private getServerTypeCandidates(plan: Plan, region: string): string[] {
    const configured = this.hetznerServerTypes[plan];
    const normalizedRegion = region.trim().toLowerCase();
    const regionDefaults =
      normalizedRegion === "iad"
        ? [DEFAULT_SERVER_TYPE_CANDIDATES[plan][0]]
        : EUROPE_SERVER_TYPE_CANDIDATES[plan];

    return [configured, ...regionDefaults, ...DEFAULT_SERVER_TYPE_CANDIDATES[plan]].filter(
      (value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index,
    );
  }

  private mapRegionToHetznerLocation(region: string): string[] {
    const normalized = region.trim().toLowerCase();
    // Keep fallbacks inside the selected geography.
    if (normalized === "iad") return ["ash", "hil"];
    if (normalized === "cdg") return ["nbg1", "hel1", "fsn1"];
    if (normalized === "fra") return ["nbg1", "hel1", "fsn1"];
    if (normalized === "ams") return ["nbg1", "hel1", "fsn1"];
    return ["nbg1", "hel1", "fsn1"];
  }

  private isInvalidLocationError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("field 'location'") || message.includes("invalid input in field 'location'");
  }

  private isUnsupportedServerLocationError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("unsupported location for server type");
  }

  private isDeprecatedServerTypeError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("server type") && message.includes("deprecated");
  }

  private isServerLocationDisabledError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("server location disabled");
  }

  private isNotFoundError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("failed (404)") || message.includes(`"code": "not_found"`) || message.includes(`"code":"not_found"`);
  }

  private isVolumeStillAttachedError(err: unknown): boolean {
    const message = String((err as any)?.message || "");
    return message.includes("volume with ID") && message.includes("is still attached to a server");
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildHetznerUserData(input: ProvisionInput, authSecret: string, volumeName: string): string {
    const loginUrl = sanitizeCloudInitValue(input.loginUrl);
    const tailscaleAuthKey = sanitizeCloudInitValue(input.tailscaleAuthKey);
    const env = [
      `NODE_ENV=production`,
      `HOST=0.0.0.0`,
      `COMPANION_HOME=/data/companion`,
      `COMPANION_SESSION_DIR=/data/sessions`,
      `COMPANION_AUTH_ENABLED=0`,
      `COMPANION_AUTH_TOKEN=${authSecret}`,
      `COMPANION_LOGIN_URL=${loginUrl}`,
      tailscaleAuthKey ? `TAILSCALE_AUTH_KEY=${tailscaleAuthKey}` : "",
    ]
      .filter(Boolean)
      .map((line) => `      ${line}`)
      .join("\n");

    return `#cloud-config
runcmd:
  - apt-get update
  - apt-get install -y docker.io
  - systemctl enable docker
  - systemctl start docker
  - mkdir -p /data
  - DEV=/dev/disk/by-id/scsi-0HC_Volume_${volumeName}
  - if [ -b "$DEV" ]; then blkid "$DEV" || mkfs.ext4 -F "$DEV"; fi
  - if [ -b "$DEV" ]; then mountpoint -q /data || mount "$DEV" /data; fi
  - if [ -b "$DEV" ]; then grep -q "$DEV /data " /etc/fstab || echo "$DEV /data ext4 defaults,nofail 0 2" >> /etc/fstab; fi
  - mkdir -p /data/companion /data/sessions
  - chown -R 10001:10001 /data
  - systemctl daemon-reload
  - systemctl enable companion.service
  - systemctl restart companion.service
write_files:
  - path: /etc/companion.env
    permissions: "0600"
    content: |
${env}
  - path: /usr/local/bin/companion-run.sh
    permissions: "0755"
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      docker rm -f companion >/dev/null 2>&1 || true
      docker run -d --name companion --restart unless-stopped -p 80:3456 -v /data:/data --env-file /etc/companion.env ${this.companionImage}
  - path: /etc/systemd/system/companion.service
    permissions: "0644"
    content: |
      [Unit]
      Description=Companion Container
      After=docker.service network-online.target
      Wants=network-online.target

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStart=/usr/local/bin/companion-run.sh
      ExecStop=/usr/bin/docker stop companion

      [Install]
      WantedBy=multi-user.target
`;
  }

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const config = PLAN_CONFIGS[input.plan];
    const authSecret = randomBytes(32).toString("hex");
    const progress = input.onProgress ?? (() => {});
    const candidateLocations = this.mapRegionToHetznerLocation(input.region);
    const candidateServerTypes = this.getServerTypeCandidates(input.plan, input.region);
    const resourceSuffix = randomBytes(4).toString("hex");
    const volumeName = makeVolumeName(input.hostname || `${input.organizationId}-${Date.now()}`, resourceSuffix);
    const machineName = makeMachineName(input.hostname || `${input.organizationId}-${Date.now()}`, resourceSuffix);
    let lastError: unknown = null;

    for (const serverType of candidateServerTypes) {
      for (const location of candidateLocations) {
      progress("creating_volume", "Creating storage volume", "in_progress");
      let volume: Awaited<ReturnType<HetznerCloudClient["createVolume"]>> | null = null;
      try {
        volume = await this.hetzner.createVolume({
          name: volumeName,
          location,
          size: config.storage_gb,
          labels: {
            app: "companion",
            organization: input.organizationId,
          },
        });
        progress("creating_volume", "Creating storage volume", "done");
      } catch (err) {
        if (this.isInvalidLocationError(err)) {
          lastError = err;
          continue;
        }
        throw err;
      }

      progress("creating_machine", "Creating server", "in_progress");
      let serverId: number | null = null;
      try {
        const response = await this.hetzner.createServer({
          name: machineName,
          server_type: serverType,
          location,
          image: "ubuntu-24.04",
          volumes: [volume.id],
          user_data: this.buildHetznerUserData(input, authSecret, volume.name),
          ssh_keys: this.hetznerSshKeyId ? [this.hetznerSshKeyId] : undefined,
          labels: {
            app: "companion",
            organization: input.organizationId,
          },
        });
        serverId = response.server.id;
        if (response.action?.id) {
          await this.hetzner.waitForAction(response.action.id, 120_000);
        }
        progress("creating_machine", "Creating server", "done");

        progress("waiting_start", "Waiting for server to start", "in_progress");
        const server = await this.hetzner.waitForServerStatus(serverId, "running", 120_000);
        progress("waiting_start", "Waiting for server to start", "done");

        return {
          providerMachineId: String(serverId),
          providerVolumeId: String(volume.id),
          authSecret,
          hostname: input.hostname || server.public_net?.ipv4?.ip || "",
        };
      } catch (err) {
        if (serverId !== null) {
          try { await this.hetzner.deleteServer(serverId); } catch {}
        }
        try { await this.hetzner.deleteVolume(volume.id); } catch {}
        if (
          this.isInvalidLocationError(err) ||
          this.isUnsupportedServerLocationError(err) ||
          this.isDeprecatedServerTypeError(err) ||
          this.isServerLocationDisabledError(err)
        ) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    }

    throw lastError ?? new Error("Failed to provision instance in available Hetzner locations");
  }

  async deprovision(machineId: string, volumeId: string): Promise<void> {
    try {
      await this.hetzner.powerOff(machineId);
    } catch (err) {
      if (!this.isNotFoundError(err)) {
        // Instance may already be stopped or removed.
      }
    }
    try {
      await this.hetzner.deleteServer(machineId);
    } catch (err) {
      if (!this.isNotFoundError(err)) throw err;
    }

    let lastVolumeError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.hetzner.deleteVolume(volumeId);
        return;
      } catch (err) {
        if (this.isNotFoundError(err)) return;
        if (!this.isVolumeStillAttachedError(err) || attempt === 4) throw err;
        lastVolumeError = err;
        await this.wait(2_000);
      }
    }

    if (lastVolumeError) throw lastVolumeError;
  }

  async start(machineId: string): Promise<void> {
    const action = await this.hetzner.powerOn(machineId);
    if (action?.id) {
      await this.hetzner.waitForAction(action.id, 90_000);
    }
    await this.hetzner.waitForServerStatus(machineId, "running", 90_000);
  }

  async stop(machineId: string): Promise<void> {
    let action: Awaited<ReturnType<HetznerCloudClient["powerOff"]>> | undefined;
    try {
      action = await this.hetzner.powerOff(machineId);
    } catch (err) {
      if (this.isNotFoundError(err)) return;
      throw err;
    }
    if (action?.id) {
      await this.hetzner.waitForAction(action.id, 90_000);
    }
    try {
      await this.hetzner.waitForServerStatus(machineId, "off", 90_000);
    } catch (err) {
      if (this.isNotFoundError(err)) return;
      throw err;
    }
  }

  async getStatus(machineId: string): Promise<string> {
    const server = await this.hetzner.getServer(machineId);
    return server.status;
  }

  async resize(machineId: string, plan: Plan): Promise<void> {
    const offAction = await this.hetzner.powerOff(machineId);
    if (offAction?.id) {
      await this.hetzner.waitForAction(offAction.id, 90_000);
    }
    await this.hetzner.waitForServerStatus(machineId, "off", 90_000);

    const changeAction = await this.hetzner.changeType(machineId, this.hetznerServerTypes[plan]);
    if (changeAction?.id) {
      await this.hetzner.waitForAction(changeAction.id, 120_000);
    }

    const onAction = await this.hetzner.powerOn(machineId);
    if (onAction?.id) {
      await this.hetzner.waitForAction(onAction.id, 90_000);
    }
    await this.hetzner.waitForServerStatus(machineId, "running", 90_000);
  }
}
