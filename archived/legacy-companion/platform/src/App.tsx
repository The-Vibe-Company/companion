import { useState, useEffect } from "react";
import { authClient } from "./lib/auth-client";
import { Dashboard } from "./pages/Dashboard";
import { Landing } from "./pages/Landing";

/**
 * Root application component for Companion Cloud.
 *
 * Auth-aware routing using Better Auth's useSession hook:
 * - Unauthenticated → Landing page (login/signup)
 * - Authenticated   → Ensure active organization → Dashboard
 *
 * After login/signup, Better Auth sessions start with no active organization.
 * The organization plugin requires an active org for all org-scoped routes
 * (instances, billing, etc). This component auto-creates a personal org on
 * first login if the user has none, and sets it active.
 */
export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  const session = authClient.useSession();
  const [orgReady, setOrgReady] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // After session loads, ensure the user has an active organization.
  useEffect(() => {
    if (!session.data) {
      setOrgReady(false);
      return;
    }

    // If session already has an active org, we're good.
    const activeOrgId = (session.data.session as any)?.activeOrganizationId;
    if (activeOrgId) {
      setOrgReady(true);
      return;
    }

    // No active org — find or create one.
    let cancelled = false;
    (async () => {
      try {
        const orgs = await authClient.organization.list();
        if (cancelled) return;

        if (orgs.data && orgs.data.length > 0) {
          // User has orgs but none active — set the first one.
          await authClient.organization.setActive({
            organizationId: orgs.data[0].id,
          });
        } else {
          // No orgs at all — create a personal workspace.
          const userName = session.data?.user?.name || "User";
          await authClient.organization.create({
            name: `${userName}'s Workspace`,
            slug: `ws-${session.data?.user?.id?.slice(0, 8) || Date.now()}`,
          });
          // create() auto-sets the new org as active unless keepCurrentActiveOrganization is true.
        }

        if (!cancelled) setOrgReady(true);
      } catch (err: any) {
        if (!cancelled) setOrgError(err.message || "Failed to set up workspace");
      }
    })();

    return () => { cancelled = true; };
  }, [session.data, retryCount]);

  // Styled loading state while checking session.
  // If there's an error (e.g. auth server not configured), treat as unauthenticated.
  if (session.isPending && !session.error) {
    return (
      <div className="h-screen bg-cc-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-2 h-2 rounded-full bg-cc-primary animate-pulse-dot" />
          <span className="font-[family-name:var(--font-display)] text-xs text-cc-muted-fg">
            companion<span className="text-cc-primary">.</span>cloud
          </span>
        </div>
      </div>
    );
  }

  // Unauthenticated or auth error → landing page
  if (!session.data) {
    return <Landing />;
  }

  // Organization setup error
  if (orgError) {
    return (
      <div className="h-screen bg-cc-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <p className="text-cc-error text-sm">{orgError}</p>
          <button
            onClick={() => { setOrgError(null); setOrgReady(false); setRetryCount(c => c + 1); }}
            className="text-cc-primary text-xs hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Waiting for organization setup
  if (!orgReady) {
    return (
      <div className="h-screen bg-cc-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-2 h-2 rounded-full bg-cc-primary animate-pulse-dot" />
          <span className="font-[family-name:var(--font-display)] text-xs text-cc-muted-fg">
            Setting up workspace…
          </span>
        </div>
      </div>
    );
  }

  // Authenticated + org ready → dashboard
  return <Dashboard />;
}
