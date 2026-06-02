import { useState } from "react";
import { Server, Globe, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

interface InstanceCardProps {
  instance: any;
  onActionComplete: () => void;
}

export function InstanceCard({ instance, onActionComplete }: InstanceCardProps) {
  const [actionLoading, setActionLoading] = useState(false);
  const isRunning = instance.machineStatus === "running" || instance.machineStatus === "started";
  const isStopped = instance.machineStatus === "stopped";

  async function handleAction(action: () => Promise<unknown>) {
    setActionLoading(true);
    try {
      await action();
      onActionComplete();
    } catch {
      // Instance action failed — card will still reflect current state
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-cc-border bg-cc-card p-5 hover:border-cc-border-hover transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-cc-muted" />
          <span className="font-[family-name:var(--font-display)] text-sm font-medium">
            {instance.hostname || instance.id?.slice(0, 8)}
          </span>
        </div>
        <StatusBadge status={instance.machineStatus} />
      </div>

      <div className="space-y-1.5 text-xs text-cc-muted mb-4">
        {instance.region && (
          <div className="flex items-center gap-1.5">
            <Globe size={12} />
            <span>{instance.region}</span>
          </div>
        )}
        {instance.ownerType && (
          <span className="inline-block px-2 py-0.5 bg-cc-hover rounded text-cc-muted-fg">
            {instance.ownerType}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        {isRunning && (
          <>
            <a
              href={instance.id ? `/api/instances/${instance.id}/embed` : "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 py-1.5 text-xs font-medium bg-cc-primary text-white rounded-lg hover:bg-cc-primary-hover transition-colors text-center"
            >
              Open
            </a>
            <button
              onClick={() => handleAction(() => api.stopInstance(instance.id))}
              disabled={actionLoading}
              className="px-3 py-1.5 text-xs border border-cc-border rounded-lg hover:bg-cc-hover transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : "Stop"}
            </button>
          </>
        )}
        {isStopped && (
          <>
            <button
              onClick={() => handleAction(() => api.startInstance(instance.id))}
              disabled={actionLoading}
              className="flex-1 py-1.5 text-xs font-medium border border-cc-border rounded-lg hover:bg-cc-hover transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin mx-auto" /> : "Start"}
            </button>
          </>
        )}
        <button
          onClick={() => {
            const confirmed = window.confirm("Delete this instance permanently?");
            if (!confirmed) return;
            void handleAction(() => api.deleteInstance(instance.id));
          }}
          disabled={actionLoading}
          className="px-3 py-1.5 text-xs border border-cc-error/40 text-cc-error rounded-lg hover:bg-cc-error/10 transition-colors disabled:opacity-50"
        >
          {actionLoading ? <Loader2 size={12} className="animate-spin" /> : "Delete"}
        </button>
      </div>
    </div>
  );
}
