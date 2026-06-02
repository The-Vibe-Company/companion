import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ProvisioningStep } from "@/lib/types";

interface CreateInstanceModalProps {
  onClose: () => void;
  onInstanceCreated: () => void;
}

const DEFAULT_REGIONS = [
  { value: "iad", label: "US East (ASH)" },
  { value: "cdg", label: "Europe (FSN)" },
];

export function CreateInstanceModal({ onClose, onInstanceCreated }: CreateInstanceModalProps) {
  const [plan, setPlan] = useState("starter");
  const [region, setRegion] = useState("iad");
  const [ownerType, setOwnerType] = useState<"shared" | "personal">("shared");
  const [regionOptions, setRegionOptions] = useState(DEFAULT_REGIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<ProvisioningStep[]>([]);
  const isStreaming = steps.length > 0;
  const hasError = steps.some((s) => s.status === "error") || !!error;

  useEffect(() => {
    let mounted = true;
    void api
      .getStatus()
      .then((status) => {
        if (!mounted) return;
        const regions = status.provisioning?.regions?.length
          ? status.provisioning.regions
          : DEFAULT_REGIONS;
        setRegionOptions(regions);
        setRegion(regions[0].value);
      })
      .catch(() => {
        if (!mounted) return;
        setRegionOptions(DEFAULT_REGIONS);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function handleCreate() {
    setLoading(true);
    setError(null);
    setSteps([]);

    try {
      await api.createInstanceStream(
        { plan, region, ownerType },
        (step) => {
          setSteps((prev) => {
            const existing = prev.findIndex((s) => s.step === step.step);
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = step;
              return next;
            }
            return [...prev, step];
          });
        },
      );
      onInstanceCreated();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to create instance");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create Instance"
      onKeyDown={(e) => e.key === "Escape" && !loading && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={loading ? undefined : onClose} />
      <div className="relative bg-cc-card border border-cc-border rounded-2xl p-8 w-full max-w-md animate-fade-slide-up">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-[family-name:var(--font-display)] font-bold">
            {isStreaming ? "Provisioning Instance" : "Create Instance"}
          </h2>
          {!loading && (
            <button onClick={onClose} className="text-cc-muted-fg hover:text-cc-fg transition-colors" aria-label="Close">
              <X size={18} />
            </button>
          )}
        </div>

        {/* ── Configuration form (hidden during streaming) ── */}
        {!isStreaming && (
          <>
            {/* Plan selection */}
            <label className="block text-xs text-cc-muted mb-2">Plan</label>
            <div className="grid grid-cols-3 gap-2 mb-5">
              {["starter", "pro", "enterprise"].map((p) => (
                <button
                  key={p}
                  onClick={() => setPlan(p)}
                  className={cn(
                    "py-2 px-3 rounded-lg text-xs font-medium border transition-all capitalize",
                    plan === p
                      ? "border-cc-primary bg-cc-primary/10 text-cc-primary"
                      : "border-cc-border hover:border-cc-border-hover",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>

            {/* Region */}
            <label htmlFor="region-select" className="block text-xs text-cc-muted mb-2">Region</label>
            <select
              id="region-select"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="w-full px-3 py-2.5 bg-cc-input-bg border border-cc-border rounded-lg text-sm text-cc-fg outline-none focus:border-cc-primary mb-5 appearance-none"
            >
              {regionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <p className="text-[11px] text-cc-muted -mt-3 mb-5">
              Provider: Hetzner Cloud
            </p>

            {/* Ownership */}
            <label className="block text-xs text-cc-muted mb-2">Ownership</label>
            <div className="grid grid-cols-2 gap-2 mb-8">
              {(["shared", "personal"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setOwnerType(o)}
                  className={cn(
                    "py-2 px-3 rounded-lg text-xs font-medium border transition-all capitalize",
                    ownerType === o
                      ? "border-cc-primary bg-cc-primary/10 text-cc-primary"
                      : "border-cc-border hover:border-cc-border-hover",
                  )}
                >
                  {o}
                </button>
              ))}
            </div>
          </>
        )}

        {/* ── Streaming progress ── */}
        {isStreaming && (
          <div className="space-y-3 mb-6">
            {steps.map((step, i) => (
              <div
                key={step.step}
                className="flex items-center gap-3"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="w-5 h-5 flex items-center justify-center shrink-0">
                  {step.status === "in_progress" && (
                    <span className="w-4 h-4 border-2 border-cc-primary/30 border-t-cc-primary rounded-full animate-spin" />
                  )}
                  {step.status === "done" && (
                    <div className="w-5 h-5 rounded-full bg-cc-success/15 flex items-center justify-center">
                      <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-cc-success">
                        <path
                          d="M13.25 4.75L6 12 2.75 8.75"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  )}
                  {step.status === "error" && (
                    <div className="w-5 h-5 rounded-full bg-cc-error/15 flex items-center justify-center">
                      <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-cc-error">
                        <path
                          d="M4 4l8 8M12 4l-8 8"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                  )}
                </div>

                <span
                  className={cn(
                    "text-xs transition-colors duration-200",
                    step.status === "in_progress" && "text-cc-fg font-medium",
                    step.status === "done" && "text-cc-muted",
                    step.status === "error" && "text-cc-error font-medium",
                  )}
                >
                  {step.label}
                </span>
              </div>
            ))}

            {/* Progress bar */}
            {!hasError && steps.length > 0 && (
              <div className="h-1 bg-cc-border/30 rounded-full overflow-hidden mt-4">
                <div
                  className="h-full bg-cc-primary/60 transition-all duration-500 ease-out rounded-full"
                  style={{
                    width: `${Math.round(
                      (steps.filter((s) => s.status === "done").length / Math.max(steps.length, 1)) * 100,
                    )}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Error display ── */}
        {error && (
          <div className="px-3 py-2.5 rounded-lg bg-cc-error/5 border border-cc-error/20 mb-4">
            <p className="text-[11px] text-cc-error whitespace-pre-wrap font-mono-code leading-relaxed">
              {error}
            </p>
          </div>
        )}

        {/* ── Action buttons ── */}
        {!isStreaming && (
          <button
            onClick={handleCreate}
            disabled={loading}
            className="w-full py-2.5 bg-cc-primary text-white rounded-lg font-medium text-sm hover:bg-cc-primary-hover transition-all disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin mx-auto" />
            ) : (
              "Create Instance"
            )}
          </button>
        )}

        {hasError && (
          <button
            onClick={onClose}
            className="w-full py-2.5 mt-2 bg-cc-hover text-cc-muted rounded-lg font-medium text-sm hover:text-cc-fg hover:bg-cc-border transition-colors"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
