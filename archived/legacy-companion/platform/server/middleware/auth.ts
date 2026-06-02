import { createMiddleware } from "hono/factory";
import { getAuth } from "../auth.js";

/**
 * Session context injected by requireAuth middleware into Hono's c.var.
 */
export interface AuthContext {
  userId: string;
  user: { id: string; email: string; name: string };
  activeOrganizationId?: string;
}

/**
 * Hono Env type for routes that use requireAuth + requireOrganization.
 * Pass this as the generic to `new Hono<AuthEnv>()` so that `c.get("auth")`
 * and `c.get("organizationId")` are properly typed.
 */
export type AuthEnv = {
  Variables: {
    auth: AuthContext;
    organizationId: string;
  };
};

/**
 * Hono middleware that verifies the Better Auth session cookie/header.
 *
 * On success, sets `c.var.auth` with the authenticated user's context.
 * On failure, returns 401 Unauthorized.
 */
export const requireAuth = createMiddleware<{
  Variables: { auth: AuthContext };
}>(async (c, next) => {
  const auth = getAuth();
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("auth", {
    userId: session.user.id,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
    activeOrganizationId: (session.session as any).activeOrganizationId,
  });

  await next();
});

/**
 * Hono middleware that requires an active organization on the session.
 *
 * Must be applied after requireAuth. Checks that the user has set an active
 * organization (via Better Auth's /api/auth/organization/set-active endpoint).
 *
 * On success, sets `c.var.organizationId` with the active organization ID.
 * On failure, returns 403 with a message explaining what to do.
 */
export const requireOrganization = createMiddleware<{
  Variables: { auth: AuthContext; organizationId: string };
}>(async (c, next) => {
  const auth = c.get("auth") as AuthContext | undefined;
  const orgId = auth?.activeOrganizationId;

  if (!orgId) {
    return c.json(
      {
        error:
          "No active organization. Set one via POST /api/auth/organization/set-active first.",
      },
      403,
    );
  }

  c.set("organizationId", orgId);
  await next();
});
