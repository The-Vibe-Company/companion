let clipboardFallbackInstalled = false;

function copyTextWithExecCommand(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined" || typeof document.execCommand !== "function") {
      reject(new Error("Clipboard fallback is unavailable"));
      return;
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (!copied) {
        reject(new Error("Copy command was rejected"));
        return;
      }
      resolve();
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Clipboard copy failed"));
    }
  });
}

function unresolvedPromise(): Promise<void> {
  return new Promise(() => {});
}

export function installClipboardWriteFallback(): void {
  if (clipboardFallbackInstalled || typeof window === "undefined") return;
  clipboardFallbackInstalled = true;

  const nav = window.navigator as Navigator & {
    clipboard?: { writeText?: (text: string) => Promise<void> };
  };
  const clipboard = nav.clipboard;

  if (clipboard?.writeText) {
    const originalWriteText = clipboard.writeText.bind(clipboard);
    try {
      clipboard.writeText = async (text: string) => {
        try {
          await originalWriteText(text);
        } catch {
          try {
            await copyTextWithExecCommand(text);
          } catch {
            // Keep promise pending so callers that only handle success do not
            // receive a false positive and we avoid unhandled rejections.
            return unresolvedPromise();
          }
        }
      };
    } catch {
      // Clipboard object is read-only in this environment.
    }
    return;
  }

  try {
    Object.defineProperty(nav, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          try {
            await copyTextWithExecCommand(text);
          } catch {
            // Keep promise pending so callers that only handle success do not
            // receive a false positive and we avoid unhandled rejections.
            return unresolvedPromise();
          }
        },
      },
    });
  } catch {
    // Navigator.clipboard cannot be reassigned in this environment.
  }
}

export function resetClipboardFallbackForTests(): void {
  clipboardFallbackInstalled = false;
}
