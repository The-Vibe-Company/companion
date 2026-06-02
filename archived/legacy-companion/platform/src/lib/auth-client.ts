/**
 * Better Auth client for the Companion Cloud frontend.
 *
 * Provides typed hooks for React 19 to manage:
 * - Session state (sign up, sign in, sign out, current user)
 * - Organization management (create, list, set active, invite members)
 * - Team management (create, list, add/remove members)
 *
 * All auth requests are routed through /api/auth/* which is handled by
 * the Better Auth server mount in platform/server/index.ts.
 */

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin + "/api/auth",
  plugins: [organizationClient({ teams: { enabled: true } })],
});

export const {
  useSession,
  signIn,
  signUp,
  signOut,
} = authClient;
