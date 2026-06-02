import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../store.js";
import { api } from "../api.js";
import {
  createTerminalConnection,
  type TerminalConnection,
} from "../terminal-ws.js";
import { TerminalAccessoryBar } from "./TerminalAccessoryBar.js";

interface TerminalViewProps {
  cwd: string;
  containerId?: string;
  title?: string;
  onClose?: () => void;
  embedded?: boolean;
  visible?: boolean;
  hideHeader?: boolean;
}

function getTerminalTheme(dark: boolean) {
  return {
    background: dark ? "#141413" : "#1e1e1e",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: "rgba(255, 255, 255, 0.2)",
  };
}

export function TerminalView({
  cwd,
  containerId,
  title,
  onClose,
  embedded = false,
  visible = true,
  hideHeader = false,
}: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const darkMode = useStore((s) => s.darkMode);

  // Main effect: create xterm + spawn PTY — only depends on cwd
  useEffect(() => {
    if (!terminalRef.current) return;

    let cancelled = false;

    const FONT_FAMILY =
      "'MesloLGS Nerd Font Mono', 'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace";
    const FONT_SIZE = window.innerWidth < 640 ? 11 : 13;

    function init() {
      if (cancelled || !terminalRef.current) return;

      const xterm = new Terminal({
        cursorBlink: true,
        fontSize: FONT_SIZE,
        fontFamily: FONT_FAMILY,
        theme: getTerminalTheme(useStore.getState().darkMode),
      });

      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(terminalRef.current);

      xtermRef.current = xterm;
      fitRef.current = fit;

      // Spawn terminal on server then connect WebSocket
      api
        .spawnTerminal(cwd, xterm.cols, xterm.rows, { containerId })
        .then(({ terminalId }) => {
          if (cancelled) return;
          useStore.getState().setTerminalId(terminalId);
          terminalIdRef.current = terminalId;

          connectionRef.current = createTerminalConnection(
            terminalId,
            {
              onData: (data) => xterm.write(data),
              onExit: (exitCode) => {
                xterm.writeln(`\r\n[Process exited with code ${exitCode}]`);
              },
              onError: (errMsg) => {
                xterm.writeln(`\r\n[${errMsg}]`);
              },
              onOpen: () => {
                // WebSocket is now open — send the actual fitted dimensions
                // (ResizeObserver may have fired before the socket was ready)
                fit.fit();
                connectionRef.current?.sendResize(xterm.cols, xterm.rows);
              },
            },
          );
        })
        .catch((err) => {
          if (cancelled) return;
          xterm.writeln(`\r\n[Failed to start terminal: ${err.message}]`);
        });

      // Forward xterm input to server
      const inputDisposable = xterm.onData((data) => connectionRef.current?.sendInput(data));

      // Handle resize — also handles initial sizing once layout is ready
      const container = terminalRef.current!;
      const resizeObserver = new ResizeObserver(() => {
        fit.fit();
        connectionRef.current?.sendResize(xterm.cols, xterm.rows);
      });
      resizeObserver.observe(container);

      // Stash disposables so cleanup can reach them
      cleanupRef.current = () => {
        resizeObserver.disconnect();
        inputDisposable.dispose();
        connectionRef.current?.disconnect();
        connectionRef.current = null;
        xterm.dispose();
        xtermRef.current = null;
        fitRef.current = null;
        const terminalId = terminalIdRef.current;
        terminalIdRef.current = null;
        if (terminalId) {
          api.killTerminal(terminalId).catch(() => {});
        }
      };
    }

    // Wait for the Nerd Font to be ready so xterm gets correct metrics from the start.
    // Falls back after 2s to avoid blocking forever if the font fails to load.
    const fontReady = document.fonts.load(`${FONT_SIZE}px ${FONT_FAMILY.split(",")[0]}`);
    const timeout = new Promise<void>((r) => setTimeout(r, 2000));
    Promise.race([fontReady, timeout]).then(init);

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [cwd, containerId]);

  // Separate effect: update theme without recreating the terminal
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = getTerminalTheme(darkMode);
    }
  }, [darkMode]);

  // Refit when panel/tab becomes visible again.
  useEffect(() => {
    if (!visible) return;
    if (!fitRef.current || !xtermRef.current) return;
    fitRef.current.fit();
    connectionRef.current?.sendResize(xtermRef.current.cols, xtermRef.current.rows);
  }, [visible]);

  // Callbacks for the mobile accessory bar
  const writeToTerminal = useCallback((data: string) => {
    connectionRef.current?.sendInput(data);
  }, []);

  const pasteToTerminal = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) connectionRef.current?.sendInput(text);
    } catch {
      // Clipboard API not available or permission denied — silently ignore
    }
  }, []);

  const terminalFrame = (
    <div
      className={`flex flex-col shadow-2xl overflow-hidden border border-cc-border ${
        embedded ? "h-full" : "w-[90vw] max-w-4xl h-[70vh]"
      }`}
      style={{ background: darkMode ? "#141413" : "#1e1e1e" }}
      onClick={(e) => e.stopPropagation()}
    >
      {!hideHeader && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-cc-border bg-cc-sidebar shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-4 h-4 text-cc-muted shrink-0"
            >
              <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1.5l3 2.5-3 2.5V4.5zM8.5 10h3v1h-3v-1z" />
            </svg>
            <span className="text-xs text-cc-muted font-mono-code truncate">
              {title || cwd}
            </span>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="w-3.5 h-3.5"
              >
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Terminal container */}
      <div ref={terminalRef} className={`flex-1 min-h-0 ${embedded ? "" : "p-1"}`} />
    </div>
  );

  const accessoryBar = (
    <TerminalAccessoryBar onWrite={writeToTerminal} onPaste={pasteToTerminal} />
  );

  if (embedded) {
    return (
      <div className={`h-full ${visible ? "" : "hidden"}`}>
        {terminalFrame}
        {accessoryBar}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      {terminalFrame}
      {accessoryBar}
    </div>
  );
}
