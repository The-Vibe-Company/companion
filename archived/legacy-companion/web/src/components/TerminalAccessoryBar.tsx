import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";

interface TerminalAccessoryBarProps {
  /** Write raw data to the terminal PTY */
  onWrite: (data: string) => void;
  /** Paste from clipboard into the terminal */
  onPaste?: () => void;
}

/** Keys that are hard/impossible to type on a mobile soft keyboard. */
const KEYS: { label: string; data: string }[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "^C", data: "\x03" },
  { label: "^D", data: "\x04" },
  { label: "^Z", data: "\x1a" },
  { label: "^L", data: "\x0c" },
  { label: "\u2191", data: "\x1b[A" },   // ↑
  { label: "\u2193", data: "\x1b[B" },   // ↓
  { label: "\u2190", data: "\x1b[D" },   // ←
  { label: "\u2192", data: "\x1b[C" },   // →
  { label: "|", data: "|" },
  { label: "~", data: "~" },
  { label: "-", data: "-" },
  { label: "/", data: "/" },
];

/** Height of the accessory bar in px — exported so the terminal container can account for it. */
export const ACCESSORY_BAR_HEIGHT = 38;

/**
 * Detect touch capability at render time rather than module load time.
 * PWA standalone mode (iOS WebKit WebView) may not have touch APIs ready
 * when JS modules are first parsed, so a static check can return false.
 * Also checks for narrow viewport as an extra heuristic — wide touch devices
 * (iPads in landscape, touch laptops) have real keyboards.
 */
function useIsTouchDevice() {
  return useSyncExternalStore(
    () => () => {},  // no subscription needed — value is stable after hydration
    () =>
      ("ontouchstart" in window || navigator.maxTouchPoints > 0) &&
      window.innerWidth < 1024,
    () => false,     // SSR fallback
  );
}

/**
 * Track the keyboard offset using the Visual Viewport API.
 * Returns the number of px the keyboard is covering from the bottom.
 * On iOS PWA standalone mode, this is the most reliable way to detect the keyboard
 * because `interactive-widget=resizes-content` may not work in the WebKit WebView.
 */
function useKeyboardOffset() {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      // visualViewport.height = visible area excluding keyboard
      // window.innerHeight = full layout viewport height
      // The difference is the keyboard height (+ any browser chrome changes)
      const kb = Math.max(0, window.innerHeight - vv.height);
      setOffset(kb);
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return offset;
}

/**
 * A slim, horizontally-scrollable bar of special keys for mobile terminals.
 * Only renders on touch-capable devices. Uses `position: fixed` and the
 * Visual Viewport API to float just above the iOS keyboard.
 */
export function TerminalAccessoryBar({ onWrite, onPaste }: TerminalAccessoryBarProps) {
  const isTouch = useIsTouchDevice();
  const keyboardOffset = useKeyboardOffset();
  const [ctrlActive, setCtrlActive] = useState(false);
  const ctrlTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleKey = useCallback(
    (data: string) => {
      if (ctrlActive && data.length === 1) {
        // Convert printable char to Ctrl+char (ascii 1-26)
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 65 && code <= 90) {
          onWrite(String.fromCharCode(code - 64));
          setCtrlActive(false);
          clearTimeout(ctrlTimeoutRef.current);
          return;
        }
      }
      onWrite(data);
      if (ctrlActive) {
        setCtrlActive(false);
        clearTimeout(ctrlTimeoutRef.current);
      }
    },
    [ctrlActive, onWrite],
  );

  const toggleCtrl = useCallback(() => {
    setCtrlActive((prev) => {
      clearTimeout(ctrlTimeoutRef.current);
      if (!prev) {
        // Auto-deactivate after 3s if no key is pressed
        ctrlTimeoutRef.current = setTimeout(() => setCtrlActive(false), 3000);
      }
      return !prev;
    });
  }, []);

  // Only show when keyboard is actually open (keyboardOffset > 0)
  if (!isTouch || keyboardOffset === 0) return null;

  return (
    <div
      className="fixed left-0 right-0 z-50 flex items-center gap-1 px-2 py-1.5 overflow-x-auto border-t border-cc-border bg-cc-card"
      style={{ bottom: keyboardOffset }}
      /* Prevent buttons from stealing focus away from xterm's hidden textarea */
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => e.preventDefault()}
    >
      {/* Ctrl modifier toggle */}
      <button
        type="button"
        className={`shrink-0 h-7 min-w-[36px] px-2 rounded text-[11px] font-semibold font-mono-code transition-colors ${
          ctrlActive
            ? "bg-cc-primary text-white"
            : "bg-cc-hover text-cc-fg"
        }`}
        onClick={toggleCtrl}
      >
        Ctrl
      </button>

      {KEYS.map((key) => (
        <button
          key={key.label}
          type="button"
          className="shrink-0 h-7 min-w-[32px] px-2 rounded bg-cc-hover text-cc-fg text-[11px] font-semibold font-mono-code active:bg-cc-active transition-colors"
          onClick={() => handleKey(key.data)}
        >
          {key.label}
        </button>
      ))}

      {/* Paste button */}
      {onPaste && (
        <button
          type="button"
          className="shrink-0 h-7 min-w-[36px] px-2 rounded bg-cc-hover text-cc-fg text-[11px] font-semibold font-mono-code active:bg-cc-active transition-colors"
          onClick={onPaste}
          title="Paste from clipboard"
        >
          Paste
        </button>
      )}
    </div>
  );
}
