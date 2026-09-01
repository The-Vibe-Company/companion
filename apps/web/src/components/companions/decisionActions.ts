"use client";

import { createContext, useContext } from "react";

/**
 * How a permission card reaches the control plane. The card renders deep inside the thread — it is a
 * part of an assistant message, several primitives down — so the action is handed to it through
 * context rather than threaded past every layer in between. `canAct` is the Owner/Editor boundary:
 * a Viewer reads the same card and is never given the controls.
 */
export type DecisionAction =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "answer"; answer: string };

/** A name this surface already loaded. Config cards never print labels from the Pi payload. */
export type DecisionNamedResource = { id: string; label: string };

export interface DecisionActions {
  canAct: boolean;
  access?: "owner" | "editor" | "viewer";
  companionId: string;
  companionName: string;
  skills: readonly DecisionNamedResource[];
  plugins: readonly DecisionNamedResource[];
  models: readonly DecisionNamedResource[];
  onDecide: (requestId: string, input: DecisionAction) => Promise<void>;
}

export const DecisionActionsContext = createContext<DecisionActions>({
  canAct: false,
  access: "viewer",
  companionId: "",
  companionName: "Companion",
  skills: [],
  plugins: [],
  models: [],
  onDecide: async () => undefined,
});

export function useDecisionActions(): DecisionActions {
  return useContext(DecisionActionsContext);
}
