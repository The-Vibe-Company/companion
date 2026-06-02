import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { captureException } from "../analytics.js";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureException(error, {
      source: "react_error_boundary",
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-[100dvh] flex items-center justify-center bg-cc-bg text-cc-fg px-4">
          <div className="max-w-md w-full rounded-xl border border-cc-border bg-cc-card p-5 shadow-sm">
            <h1 className="text-base font-semibold">A runtime error occurred</h1>
            <p className="text-sm text-cc-muted mt-2">
              Reload the page to recover. The error has been reported.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex items-center rounded-md bg-cc-primary px-3 py-1.5 text-sm text-white hover:bg-cc-primary-hover cursor-pointer"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
