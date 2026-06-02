import { useState, useEffect, useCallback } from "react";
import { Loader2, Menu } from "lucide-react";
import { api } from "@/lib/api";
import { DashboardSidebar, type DashboardPage } from "@/components/DashboardSidebar";
import { InstanceCard } from "@/components/InstanceCard";
import { EmptyState } from "@/components/EmptyState";
import { CreateInstanceButton } from "@/components/CreateInstanceButton";
import { useInstancePolling } from "@/hooks/useInstancePolling";

/**
 * Dashboard page with sidebar navigation and instance management.
 * Shows instance list or empty state. Supports creating new instances
 * with real-time SSE progress streaming.
 */
export function Dashboard() {
  const [page, setPage] = useState<DashboardPage>("instances");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [instances, setInstances] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInstances = useCallback(async () => {
    try {
      const data = await api.listInstances();
      setInstances(data.instances || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load instances");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  // Poll for status updates when instances are in transitional states
  useInstancePolling(instances, loadInstances);

  return (
    <div className="h-screen flex bg-cc-bg text-cc-fg">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <DashboardSidebar
        page={page}
        onNavigate={setPage}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* ── Main Content ─────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 flex items-center justify-between px-6 border-b border-cc-separator shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden text-cc-muted hover:text-cc-fg"
              aria-label="Open sidebar"
            >
              <Menu size={20} />
            </button>
            <h1 className="font-medium text-sm capitalize">{page}</h1>
          </div>
          {page === "instances" && (
            <CreateInstanceButton onInstanceCreated={loadInstances} />
          )}
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {page === "instances" && (
            <InstancesView
              instances={instances}
              loading={loading}
              error={error}
              onRefresh={loadInstances}
            />
          )}
          {page === "settings" && <SettingsView />}
          {page === "team" && <TeamView />}
        </div>
      </main>
    </div>
  );
}

/* ─── Instances View ──────────────────────────────────────────────────────── */

interface InstancesViewProps {
  instances: any[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function InstancesView({ instances, loading, error, onRefresh }: InstancesViewProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-cc-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <p className="text-cc-error text-sm mb-2">Failed to load instances</p>
        <p className="text-cc-muted text-xs">{error}</p>
      </div>
    );
  }

  if (instances.length === 0) {
    return <EmptyState onInstanceCreated={onRefresh} />;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
      {instances.map((inst: any) => (
        <InstanceCard key={inst.id} instance={inst} onActionComplete={onRefresh} />
      ))}
    </div>
  );
}

/* ─── Stub Pages ──────────────────────────────────────────────────────────── */

function SettingsView() {
  return (
    <div className="max-w-lg">
      <h2 className="font-[family-name:var(--font-display)] font-bold text-lg mb-4">Settings</h2>
      <p className="text-cc-muted text-sm">Account settings coming soon.</p>
    </div>
  );
}

function TeamView() {
  return (
    <div className="max-w-lg">
      <h2 className="font-[family-name:var(--font-display)] font-bold text-lg mb-4">Team</h2>
      <p className="text-cc-muted text-sm">Team management coming soon.</p>
    </div>
  );
}
