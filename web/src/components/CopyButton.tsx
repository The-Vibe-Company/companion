import { useState } from 'react';

interface CopyButtonProps {
  text: string;
  className?: string;
  size?: 'sm' | 'md';
  label?: string;
}

export function CopyButton({ text, className = '', size = 'sm', label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without clipboard API
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textArea);
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const sizeClass = size === 'md' ? 'w-5 h-5' : 'w-4 h-4';

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors ${className}`}
      title={label || 'Copy to clipboard'}
    >
      {copied ? (
        <svg className={`${sizeClass} text-green-500`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className={sizeClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
        </svg>
      )}
    </button>
  );
}