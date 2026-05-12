import { Component, ReactNode, ErrorInfo } from "react";

/**
 * Catches any thrown error inside its children and renders the error +
 * stack onto the page so we can see what crashed. Without this, a thrown
 * exception inside React's render phase blanks the entire app with no
 * trace — exactly the symptom of the blank-on-drag bug.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; info: ErrorInfo | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught:", error, info);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            background: "rgba(20,8,8,0.96)",
            color: "#ff8a93",
            padding: 24,
            font: "12px/1.5 ui-monospace, monospace",
            overflow: "auto",
          }}
        >
          <h2 style={{ color: "#ff6b6b", marginTop: 0 }}>
            UI crashed — caught by ErrorBoundary
          </h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "#ffb0b6" }}>
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7 }}>
            {this.state.error?.stack ?? ""}
          </pre>
          {this.state.info?.componentStack && (
            <pre style={{ whiteSpace: "pre-wrap", opacity: 0.5 }}>
              {this.state.info.componentStack}
            </pre>
          )}
          <button
            type="button"
            onClick={this.reset}
            style={{
              marginTop: 12,
              padding: "8px 16px",
              background: "#3a1d1d",
              color: "#ffb0b6",
              border: "1px solid #ff6b6b",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
