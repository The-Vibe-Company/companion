import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { instances } from "./routes/instances.js";
import { billing, stripeWebhook } from "./routes/billing.js";
import { dashboard } from "./routes/dashboard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3458;
const instanceProvider = "hetzner";
const provisioningRegions = [
  { value: "iad", label: "US East (ASH)" },
  { value: "cdg", label: "Europe (FSN)" },
];

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────────────────────────
// credentials: true allows Better Auth session cookies to be sent cross-origin.
// origin must be set explicitly when credentials is true.
app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      const allowed = (process.env.COMPANION_CLOUD_ORIGINS || "http://localhost:5175").split(",").map(s => s.trim());
      return allowed.includes(origin) ? origin : allowed[0];
    },
    credentials: true,
  }),
);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true }));

// ── Better Auth ──────────────────────────────────────────────────────────────
// Mount the Better Auth handler for all auth routes. This is a catch-all that
// delegates to Better Auth's built-in endpoints (sign-up, sign-in, session,
// organization CRUD, team CRUD, invitations, etc.).
// Uses lazy import to avoid crashing when env vars aren't set (e.g. in tests
// that don't exercise auth routes).
app.all("/api/auth/*", async (c) => {
  try {
    const { getAuth } = await import("./auth.js");
    const res = await getAuth().handler(c.req.raw);
    if (res.status >= 400) {
      const body = await res.clone().text();
      console.error(`[auth] ${c.req.method} ${c.req.path} → ${res.status}: ${body}`);
    }
    return res;
  } catch (e: any) {
    console.error("[auth] Error:", e.message);
    return c.json({ error: e.message }, 500);
  }
});

// ── API Routes ───────────────────────────────────────────────────────────────
app.route("/api/instances", instances);
app.route("/api/billing", billing);
app.route("/api/webhooks", stripeWebhook);
app.route("/api/dashboard", dashboard);

app.get("/api/status", (c) => {
  return c.json({
    service: "companion-cloud",
    version: "0.1.0",
    status: "ok",
    provisioning: {
      provider: instanceProvider,
      regions: provisioningRegions,
    },
  });
});

// ── Static files (production) / Dev redirect ────────────────────────────────
if (process.env.NODE_ENV === "production") {
  // Dynamic import avoids "Bun is not defined" when running under Node/vitest.
  const { serveStatic } = await import("hono/bun");
  const distDir = resolve(__dirname, "../dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
} else if (typeof globalThis.Bun !== "undefined") {
  // In dev mode, redirect to Vite dev server for the frontend.
  app.get("/", (c) => c.redirect("http://localhost:5175"));
}

// ── Start ────────────────────────────────────────────────────────────────────
export default {
  port,
  fetch: app.fetch,
};

console.log(`[companion-cloud] Control plane running on http://localhost:${port}`);
