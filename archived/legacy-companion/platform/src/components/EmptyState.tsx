import { Terminal } from "lucide-react";
import { CreateInstanceButton } from "./CreateInstanceButton";

interface EmptyStateProps {
  onInstanceCreated: () => void;
}

export function EmptyState({ onInstanceCreated }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <div className="w-16 h-16 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center mb-6">
        <Terminal size={28} className="text-cc-muted-fg" />
      </div>
      <h2 className="font-[family-name:var(--font-display)] font-bold text-lg mb-2">
        No instances yet
      </h2>
      <p className="text-cc-muted text-sm max-w-sm mb-6">
        Create your first Companion instance to start building with Claude Code
        in the browser.
      </p>
      <CreateInstanceButton onInstanceCreated={onInstanceCreated} />
    </div>
  );
}
