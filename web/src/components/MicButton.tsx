interface MicButtonProps {
  isListening: boolean;
  isSupported: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export function MicButton({ isListening, isSupported, onClick, disabled }: MicButtonProps) {
  if (!isSupported) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Toggle voice input"
      aria-pressed={isListening}
      title="Voice input (Ctrl+Shift+M)"
      className={`relative flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${
        disabled
          ? "text-cc-muted opacity-30 cursor-not-allowed"
          : isListening
            ? "text-cc-error hover:bg-cc-error/10 cursor-pointer"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
      }`}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
        <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
        <path d="M3.5 7a4.5 4.5 0 009 0" strokeLinecap="round" />
        <path d="M8 12.5v2M6 14.5h4" strokeLinecap="round" />
      </svg>
      {isListening && !disabled && (
        <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-cc-error animate-pulse" />
      )}
    </button>
  );
}
