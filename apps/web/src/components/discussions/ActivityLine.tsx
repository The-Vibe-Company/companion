import { useState } from "react";
import { Square } from "lucide-react";

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
