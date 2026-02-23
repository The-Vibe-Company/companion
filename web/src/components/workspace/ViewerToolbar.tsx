import { useState, useCallback, useEffect, useRef } from "react";

export interface ViewerToolbarProps {
  fileName: string | null;
  onClose: () => void;
  onDownload: () => void;
  onShareLink: () => void;
}

/**
 * ViewerToolbar — top bar for the fullscreen workspace document viewer.
 *
 * Displays the file name (extracted from full path), and provides
 * download, share-link, and close actions. The share-link button
 * shows "Copied!" feedback for 2 seconds after being clicked.
 */
export function ViewerToolbar({
  fileName,
  onClose,
  onDownload,
  onShareLink,
}: ViewerToolbarProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayName = fileName?.split("/").pop() ?? null;

  const handleShareLink = useCallback(() => {
    onShareLink();
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [onShareLink]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  return (
    <div className="shrink-0 h-11 flex items-center gap-2 px-3 border-b border-cc-border bg-cc-card">
      {/* File name */}
      <div className="flex-1 min-w-0">
        {displayName ? (
          <span
            className="text-[13px] font-medium text-cc-fg truncate block"
            title={fileName ?? undefined}
          >
            {displayName}
          </span>
        ) : (
          <span className="text-[13px] text-cc-muted italic">No file selected</span>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Download */}
        <button
          onClick={onDownload}
          className="flex items-center justify-center w-7 h-7 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          title="Download file"
          aria-label="Download file"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M8 1a.5.5 0 01.5.5v8.793l2.146-2.147a.5.5 0 01.708.708l-3 3a.5.5 0 01-.708 0l-3-3a.5.5 0 11.708-.708L7.5 10.293V1.5A.5.5 0 018 1zM2 13.5a.5.5 0 01.5-.5h11a.5.5 0 010 1h-11a.5.5 0 01-.5-.5z" />
          </svg>
        </button>

        {/* Share link / Copied feedback */}
        <button
          onClick={handleShareLink}
          className={`flex items-center justify-center h-7 rounded-md transition-colors cursor-pointer ${
            copied
              ? "text-cc-success px-2 gap-1"
              : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover w-7"
          }`}
          title={copied ? "Link copied!" : "Copy share link"}
          aria-label={copied ? "Link copied" : "Copy share link"}
        >
          {copied ? (
            <>
              {/* Check icon */}
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z" />
              </svg>
              <span className="text-[11px] font-medium">Copied!</span>
            </>
          ) : (
            /* Link / share icon */
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M6.354 5.5H4a3 3 0 000 6h3a3 3 0 002.83-4H8.535a2 2 0 01-1.535.726H4.5a2 2 0 110-4h1.854a4 4 0 01-.354-.726zM9.646 10.5H12a3 3 0 000-6H9a3 3 0 00-2.83 4h1.295A2 2 0 018.535 7.774H11.5a2 2 0 110 4H9.646a4 4 0 00.354.726z" />
            </svg>
          )}
        </button>

        {/* Close */}
        <button
          onClick={onClose}
          className="flex items-center justify-center w-7 h-7 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          title="Close fullscreen (Esc)"
          aria-label="Close fullscreen"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
