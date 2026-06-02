import { Component, type ReactNode } from "react";
import { captureException } from "../analytics.js";

interface Props {
  children: ReactNode;
  /** Optional label shown in the error UI (e.g. section name) */
  label?: string;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render errors within a section and displays a compact fallback,
 * preventing a single broken section from crashing the entire app.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    captureException(error, { section: this.props.label });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="px-4 py-3 border-b border-cc-border">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-cc-error">
              {this.props.label ? `${this.props.label} failed to load` : "Section failed to load"}
            </span>
            <button
              className="text-[10px] text-cc-muted hover:text-cc-fg px-2 py-0.5 rounded bg-cc-hover cursor-pointer"
              onClick={() => this.setState({ hasError: false })}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
