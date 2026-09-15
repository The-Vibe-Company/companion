import { useState, type ReactNode } from "react";
import { Square } from "lucide-react";
import { workStatus } from "./shared";

/** The single status vocabulary: one dot, one label, colours from --status-*. */
export function WorkStatus({ status, label }: { status: string; label?: string }) {
  return <span className="work-status" data-status={status}><i className="status-dot" aria-hidden="true" />{label ?? workStatus(status)}</span>;
}

/**
 * One line per run that is still the reader's business: who, what state, how to stop it.
 * Results, previews and finished work stay in the companion's workbench.
 */
export function ActivityLine({ name, mark, status, error, onOpen, stop }: {
  name: string; mark: ReactNode; status: string; error?: string | null;
  onOpen?: () => void; stop?: ReactNode;
}) {
  return <div className="activity-line" data-status={status}>
    {onOpen
      ? <button type="button" className="activity-agent" aria-label={`Open ${name} workspace`} onClick={onOpen}>{mark}</button>
      : <span className="activity-agent">{mark}</span>}
    <div className="activity-copy">
      <WorkStatus status={status} label={`${name} · ${workStatus(status)}`} />
      {error && <p className="task-error" role="status">{error}</p>}
    </div>
    {stop}
  </div>;
}

export function StopControl({ label, onStop, onRefresh, onError }: {
  label: string; onStop: () => Promise<unknown>; onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "requested">("idle");
  async function stop() {
    if (state !== "idle") return;
    setState("sending");
    try { await onStop(); setState("requested"); }
    catch (cause) { setState("idle"); onError(cause); return; }
    try { await onRefresh(); } catch (cause) { onError(cause); }
  }
  return <div className="stop-control">
    {state !== "idle" && <span role="status">{state === "sending" ? "Requesting stop…" : "Stop requested"}</span>}
    <button type="button" className="quiet-stop" disabled={state !== "idle"} aria-label={label} title={label} onClick={() => void stop()}><Square aria-hidden="true" /></button>
  </div>;
}
