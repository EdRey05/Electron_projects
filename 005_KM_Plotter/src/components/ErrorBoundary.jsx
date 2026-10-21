/**
 * Error boundary.
 *
 * A rendering fault in one panel should not blank the whole app — it shows a
 * message in place of the broken subtree and keeps the rest of the UI alive.
 */
import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error("KM Plotter render error:", error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="m-4 rounded-xl border border-[#4E2129] bg-[#331418] p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-[#4E2129] p-2 text-[#FB7185]">
            <AlertTriangle size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[#F5A3AE]">This panel failed to render</p>
            <p className="mt-1 text-xs leading-relaxed text-[#F5A3AE]/80">
              {String(error && error.message ? error.message : error)}
            </p>
            {info && info.componentStack && (
              <details className="mt-2 text-[11px] text-[#F5A3AE]/60">
                <summary className="cursor-pointer">Technical details</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all">{info.componentStack}</pre>
              </details>
            )}
            <button
              onClick={() => this.setState({ error: null, info: null })}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[#4E2129] bg-[#3B1B20] px-3 py-1.5 text-xs text-[#F5A3AE] hover:bg-[#4E2129]"
            >
              <RotateCcw size={13} />
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
