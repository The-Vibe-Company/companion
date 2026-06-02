import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import {
  requireAuth,
  requireOrganization,
  type AuthEnv,
} from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { instances as instancesTable } from "../db/schema.js";
import { createInstanceToken } from "../lib/token.js";
import { Provisioner, type Plan } from "../services/provisioner.js";

const instances = new Hono<AuthEnv>();
const VALID_PLANS: Plan[] = ["starter", "pro", "enterprise"];

function getProvisioner(): Provisioner {
  const hetznerToken = process.env.HETZNER_API_TOKEN;
  const companionImage = process.env.COMPANION_IMAGE;
  const missing = [
    !hetznerToken && "HETZNER_API_TOKEN",
    !companionImage && "COMPANION_IMAGE",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return new Provisioner({
    hetznerToken: hetznerToken!,
    companionImage: companionImage!,
    hetznerSshKeyId: process.env.HETZNER_SSH_KEY_ID,
    hetznerServerTypes: {
      starter: process.env.HETZNER_SERVER_TYPE_STARTER || undefined,
      pro: process.env.HETZNER_SERVER_TYPE_PRO || undefined,
      enterprise: process.env.HETZNER_SERVER_TYPE_ENTERPRISE || undefined,
    },
  });
}

function normalizeHostname(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\/.*$/, "");
}

function makeHostname(requested?: string): string {
  if (requested?.trim()) return normalizeHostname(requested);
  return "";
}

function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("localhost:") ||
    normalized.startsWith("127.0.0.1:") ||
    normalized.startsWith("[::1]:")
  );
}

function resolveLoginUrl(c: any): string {
  const explicit = process.env.COMPANION_LOGIN_URL?.trim();
  if (explicit) return explicit;

  const forwardedHost = c.req.header("x-forwarded-host");
  const forwardedProto = c.req.header("x-forwarded-proto");
  const reqUrl = new URL(c.req.url);
  const host = (forwardedHost || reqUrl.host || "").trim();
  const proto = (forwardedProto || reqUrl.protocol.replace(/:$/, "") || "https").trim();

  if (!host || isLocalHost(host)) return "";
  return `${proto}://${host}/login`;
}

async function getAuthorizedInstance(instanceId: string, orgId: string, userId: string) {
  const db = getDb();
  const row = await db.query.instances.findFirst({
    where: and(
      eq(instancesTable.id, instanceId),
      eq(instancesTable.organizationId, orgId),
      or(eq(instancesTable.ownerType, "shared"), eq(instancesTable.ownerId, userId)),
    ),
  });

  return row ?? null;
}

async function getOwnedInstance(instanceId: string, orgId: string, userId: string) {
  const db = getDb();
  const row = await db.query.instances.findFirst({
    where: and(
      eq(instancesTable.id, instanceId),
      eq(instancesTable.organizationId, orgId),
      or(
        eq(instancesTable.ownerId, userId),
        and(eq(instancesTable.ownerType, "shared"), isNull(instancesTable.ownerId)),
      ),
    ),
  });

  return row ?? null;
}

instances.use("/*", requireAuth, requireOrganization);

function sanitizeInstance(row: Record<string, unknown>) {
  const { authSecret, ...safe } = row as Record<string, unknown> & { authSecret?: unknown };
  return safe;
}

function resolveAuthMode(row: { config?: unknown }): "managed_jwt" | "static_token" {
  const cfg = row.config;
  if (cfg && typeof cfg === "object") {
    const mode = (cfg as Record<string, unknown>).authMode;
    if (mode === "static_token" || mode === "managed_jwt") {
      return mode;
    }
  }
  // Backward-compatible default for existing instances created before authMode tracking.
  return "managed_jwt";
}

instances.get("/", async (c) => {
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const db = getDb();

  const rows = await db.query.instances.findMany({
    where: and(
      eq(instancesTable.organizationId, orgId),
      or(eq(instancesTable.ownerType, "shared"), eq(instancesTable.ownerId, userId)),
    ),
  });

  return c.json({ instances: rows.map(sanitizeInstance), organizationId: orgId, userId });
});

instances.post("/", async (c) => {
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const body = await c.req.json<{
    plan?: string;
    region?: string;
    hostname?: string;
    ownerType?: "shared" | "personal";
  }>();

  const ownerType = body.ownerType || "shared";
  const ownerId = userId;
  const plan = (body.plan || "starter") as Plan;
  const region = body.region || "iad";

  if (!VALID_PLANS.includes(plan)) {
    return c.json({ error: `Invalid plan: ${body.plan}` }, 400);
  }

  let provisioner: Provisioner;
  try {
    provisioner = getProvisioner();
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }

  const hostname = makeHostname(body.hostname);
  const loginUrl = resolveLoginUrl(c);

  const provisioned = await provisioner.provision({
    organizationId: orgId,
    plan,
    region,
    hostname,
    loginUrl,
  });

  const db = getDb();
  const [created] = await db
    .insert(instancesTable)
    .values({
      organizationId: orgId,
      ownerId,
      ownerType,
      providerMachineId: provisioned.providerMachineId,
      providerVolumeId: provisioned.providerVolumeId,
      region,
      hostname: provisioned.hostname,
      machineStatus: "started",
      authSecret: provisioned.authSecret,
      config: { plan, provider: "hetzner", authMode: "static_token" },
    })
    .returning();

  return c.json({
    message: "Instance provisioned",
    instance: created,
  });
});

instances.post("/create-stream", async (c) => {
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const body = await c.req.json<{
    plan?: string;
    region?: string;
    hostname?: string;
    ownerType?: "shared" | "personal";
  }>();

  const ownerType = body.ownerType || "shared";
  const ownerId = userId;
  const plan = (body.plan || "starter") as Plan;
  const region = body.region || "iad";

  if (!VALID_PLANS.includes(plan)) {
    return c.json({ error: `Invalid plan: ${body.plan}` }, 400);
  }

  let provisioner: Provisioner;
  try {
    provisioner = getProvisioner();
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }

  const emitProgress = (
    stream: SSEStreamingApi,
    step: string,
    label: string,
    status: "in_progress" | "done" | "error",
  ) =>
    stream.writeSSE({
      event: "progress",
      data: JSON.stringify({ step, label, status }),
    });

  return streamSSE(c, async (stream) => {
    let activeStep: { step: string; label: string } | null = null;
    let provisioned: Awaited<ReturnType<Provisioner["provision"]>> | null = null;

    try {
      const hostname = makeHostname(body.hostname);
      const loginUrl = resolveLoginUrl(c);

      provisioned = await provisioner.provision({
        organizationId: orgId,
        plan,
        region,
        hostname,
        loginUrl,
        onProgress: (step, label, status) => {
          if (status === "in_progress") activeStep = { step, label };
          else if (status === "done") activeStep = null;
          void emitProgress(stream, step, label, status).catch(() => {});
        },
      });

      activeStep = { step: "saving_db", label: "Saving instance" };
      await emitProgress(stream, "saving_db", "Saving instance", "in_progress");
      const db = getDb();
      const [created] = await db
        .insert(instancesTable)
        .values({
          organizationId: orgId,
          ownerId,
          ownerType,
          providerMachineId: provisioned.providerMachineId,
          providerVolumeId: provisioned.providerVolumeId,
          region,
          hostname: provisioned.hostname,
          machineStatus: "started",
          authSecret: provisioned.authSecret,
          config: { plan, provider: "hetzner", authMode: "static_token" },
        })
        .returning();
      provisioned = null;
      await emitProgress(stream, "saving_db", "Saving instance", "done");
      activeStep = null;

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ instance: sanitizeInstance(created) }),
      });
    } catch (err: any) {
      if (activeStep) {
        await emitProgress(stream, activeStep.step, activeStep.label, "error").catch(() => {});
      }

      if (provisioned) {
        try {
          await provisioner.deprovision(provisioned.providerMachineId, provisioned.providerVolumeId);
        } catch {
          // Best-effort cleanup.
        }
      }

      const message = err.message || "Instance creation failed";
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: message }),
      });
    }
  });
});

instances.get("/:id", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);

  return c.json(sanitizeInstance(row));
});

instances.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getOwnedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found or not owned by user" }, 404);

  if (row.providerMachineId && row.providerVolumeId) {
    const provisioner = getProvisioner();
    await provisioner.deprovision(row.providerMachineId, row.providerVolumeId);
  }

  const db = getDb();
  await db.delete(instancesTable).where(eq(instancesTable.id, id));
  return c.json({ id, message: "Instance destroyed" });
});

instances.post("/:id/start", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.start(row.providerMachineId);

  const db = getDb();
  await db
    .update(instancesTable)
    .set({ machineStatus: "started" })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Started" });
});

instances.post("/:id/stop", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.stop(row.providerMachineId);

  const db = getDb();
  await db
    .update(instancesTable)
    .set({ machineStatus: "stopped" })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Stopped" });
});

instances.post("/:id/restart", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.stop(row.providerMachineId);
  await provisioner.start(row.providerMachineId);

  const db = getDb();
  await db
    .update(instancesTable)
    .set({ machineStatus: "started" })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Restarted" });
});

instances.post("/:id/scale", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const body = await c.req.json<{ plan?: string }>();
  const plan = body.plan as Plan;

  if (!VALID_PLANS.includes(plan)) {
    return c.json({ error: `Invalid plan: ${body.plan}` }, 400);
  }

  const row = await getOwnedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);
  if (!row.providerMachineId) return c.json({ error: "Instance has no provisioned machine" }, 409);

  const provisioner = getProvisioner();
  await provisioner.resize(row.providerMachineId, plan);
  const currentConfig =
    row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {};

  const db = getDb();
  await db
    .update(instancesTable)
    .set({
      machineStatus: "started",
      config: { ...currentConfig, plan, provider: "hetzner", authMode: currentConfig.authMode || "static_token" },
    })
    .where(eq(instancesTable.id, id));

  return c.json({ id, message: "Scaled", plan });
});

instances.post("/:id/token", async (c) => {
  const id = c.req.param("id");
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;

  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);

  const token =
    resolveAuthMode(row) === "static_token"
      ? row.authSecret
      : await createInstanceToken(row.authSecret);
  return c.json({ id, token });
});

instances.get("/:id/embed", async (c) => {
  const id = c.req.param("id");

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(id)) {
    return c.json({ error: "Invalid instance ID" }, 400);
  }

  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const row = await getAuthorizedInstance(id, orgId, userId);
  if (!row) return c.json({ error: "Instance not found" }, 404);

  const token =
    resolveAuthMode(row) === "static_token"
      ? row.authSecret
      : await createInstanceToken(row.authSecret);
  const isIpv4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(row.hostname || "");
  const protocol = isIpv4 ? "http" : "https";
  const url = new URL(`${protocol}://${row.hostname}`);
  url.searchParams.set("token", token);
  return c.redirect(url.toString());
});

export { instances };
