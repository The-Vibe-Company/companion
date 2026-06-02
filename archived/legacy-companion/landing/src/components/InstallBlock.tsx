import { CopyButton } from "./CopyButton";

const COMMAND = "bunx the-companion";

export function InstallBlock({ large }: { large?: boolean }) {
  return (
    <div
      className={`inline-flex items-center gap-2 sm:gap-3 bg-cc-code-bg text-cc-code-fg rounded-xl border border-[#40372e] shadow-[0_6px_14px_rgba(10,7,5,0.34)] font-mono-code max-w-full whitespace-nowrap ${
        large ? "px-4 sm:px-6 py-3.5 sm:py-4 text-sm sm:text-lg" : "px-4 sm:px-5 py-3 text-[13px] sm:text-[15px]"
      }`}
    >
      <span className="text-cc-teal select-none">$</span>
      <span>{COMMAND}</span>
      <CopyButton text={COMMAND} />
    </div>
  );
}
