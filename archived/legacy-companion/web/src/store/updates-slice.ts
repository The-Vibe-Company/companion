import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { UpdateInfo, CreationProgressEvent } from "../api.js";

function getInitialDismissedVersion(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-update-dismissed") || null;
}

export interface UpdatesSlice {
  updateInfo: UpdateInfo | null;
  updateDismissedVersion: string | null;
  updateOverlayActive: boolean;
  dockerUpdateDialogOpen: boolean;
  creationProgress: CreationProgressEvent[] | null;
  creationError: string | null;
  sessionCreating: boolean;
  sessionCreatingBackend: "claude" | "codex" | null;

  setUpdateInfo: (info: UpdateInfo | null) => void;
  dismissUpdate: (version: string) => void;
  setUpdateOverlayActive: (active: boolean) => void;
  setDockerUpdateDialogOpen: (open: boolean) => void;
  addCreationProgress: (step: CreationProgressEvent) => void;
  clearCreation: () => void;
  setSessionCreating: (creating: boolean, backend?: "claude" | "codex") => void;
  setCreationError: (error: string | null) => void;
}

export const createUpdatesSlice: StateCreator<AppState, [], [], UpdatesSlice> = (set) => ({
  updateInfo: null,
  updateDismissedVersion: getInitialDismissedVersion(),
  updateOverlayActive: false,
  dockerUpdateDialogOpen: false,
  creationProgress: null,
  creationError: null,
  sessionCreating: false,
  sessionCreatingBackend: null,

  setUpdateInfo: (info) => set({ updateInfo: info }),
  dismissUpdate: (version) => {
    localStorage.setItem("cc-update-dismissed", version);
    set({ updateDismissedVersion: version });
  },
  setUpdateOverlayActive: (active) => set({ updateOverlayActive: active }),
  setDockerUpdateDialogOpen: (open) => set({ dockerUpdateDialogOpen: open }),

  addCreationProgress: (step) => set((state) => {
    const existing = state.creationProgress || [];
    const idx = existing.findIndex((s) => s.step === step.step);
    if (idx >= 0) {
      const updated = [...existing];
      updated[idx] = step;
      return { creationProgress: updated };
    }
    return { creationProgress: [...existing, step] };
  }),
  clearCreation: () => set({ creationProgress: null, creationError: null, sessionCreating: false, sessionCreatingBackend: null }),
  setSessionCreating: (creating, backend) => set({ sessionCreating: creating, sessionCreatingBackend: backend ?? null }),
  setCreationError: (error) => set({ creationError: error }),
});
