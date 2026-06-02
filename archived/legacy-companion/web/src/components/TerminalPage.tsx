import { useState } from "react";
import { useStore } from "../store.js";
import { FolderPicker } from "./FolderPicker.js";
import { TerminalView } from "./TerminalView.js";

export function TerminalPage() {
  const terminalCwd = useStore((s) => s.terminalCwd);
  const [showTerminalPicker, setShowTerminalPicker] = useState(false);

  return (
    <div className="h-full bg-cc-bg overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe h-full flex flex-col">
        <div className="flex items-start justify-between gap-3 mb-6 shrink-0">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Terminal</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Run shell commands in a project folder without leaving the Companion.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowTerminalPicker(true)}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer whitespace-nowrap"
          >
            {terminalCwd ? "Change Folder" : "Choose Folder"}
          </button>
        </div>

        <div className="flex-1 min-h-[420px]">
          {terminalCwd ? (
            <TerminalView cwd={terminalCwd} embedded />
          ) : (
            <div className="h-full bg-cc-card border border-cc-border rounded-xl p-6 sm:p-8 flex items-center justify-center text-center">
              <div className="max-w-md">
                <h2 className="text-lg font-semibold text-cc-fg mb-2">No terminal started yet</h2>
                <p className="text-sm text-cc-muted">
                  Choose a folder to start a terminal session. You can switch folders anytime.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showTerminalPicker && (
        <FolderPicker
          initialPath={terminalCwd || ""}
          onSelect={(path) => {
            useStore.getState().openTerminal(path);
            window.location.hash = "#/terminal";
            setShowTerminalPicker(false);
          }}
          onClose={() => setShowTerminalPicker(false)}
        />
      )}
    </div>
  );
}
