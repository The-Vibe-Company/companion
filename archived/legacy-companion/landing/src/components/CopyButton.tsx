import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((err) => {
        console.error("Failed to copy to clipboard:", err);
      });
  };

  return (
    <button
      onClick={handleCopy}
      aria-label="Copy to clipboard"
      className="text-cc-muted hover:text-cc-code-fg p-1 rounded transition-colors cursor-pointer relative hover:bg-white/5"
    >
      {copied ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="13 4 6 11 3 8" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 11V3.5A1.5 1.5 0 0 1 5.5 2H11" />
          <rect x="6" y="5" width="7" height="8" rx="1.5" />
        </svg>
      )}
    </button>
  );
}
