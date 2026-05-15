export function Footer() {
  return (
    <footer className="relative z-10 border-t border-cc-border py-10 px-5 sm:px-7 text-center text-sm text-cc-muted">
      <p className="font-mono-code tracking-wide">
        Maintained by{" "}
        <a href="https://github.com/yajin" target="_blank" rel="noopener" className="hover:text-cc-fg transition-colors">
          Yajin
        </a>
      </p>
      <div className="flex justify-center gap-6 mt-2">
        <a href="https://github.com/yajin/AgentHangar" target="_blank" rel="noopener" className="text-cc-muted hover:text-cc-fg transition-colors">
          GitHub
        </a>
        <a href="https://www.npmjs.com/package/agenthangar" target="_blank" rel="noopener" className="text-cc-muted hover:text-cc-fg transition-colors">
          npm
        </a>
        <a href="https://github.com/yajin/AgentHangar/blob/main/LICENSE" target="_blank" rel="noopener" className="text-cc-muted hover:text-cc-fg transition-colors">
          MIT License
        </a>
      </div>
    </footer>
  );
}
