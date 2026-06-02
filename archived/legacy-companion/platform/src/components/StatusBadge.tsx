import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status?: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const isRunning = status === "running" || status === "started";
  const isStopped = status === "stopped";
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full",
        isRunning && "bg-cc-success/10 text-cc-success",
        isStopped && "bg-cc-muted-fg/10 text-cc-muted-fg",
        !isRunning && !isStopped && "bg-cc-warning/10 text-cc-warning",
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          isRunning && "bg-cc-success animate-pulse-dot",
          isStopped && "bg-cc-muted-fg",
          !isRunning && !isStopped && "bg-cc-warning animate-pulse-dot",
        )}
      />
      {status || "unknown"}
    </span>
  );
}
