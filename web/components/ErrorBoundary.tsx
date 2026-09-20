import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { name: string; children: ReactNode; /** Compact card for panels; full page for the root */ full?: boolean }
interface State { error: Error | null }

/** A crash in one panel shows an error card there; the rest of the console (and the video) keeps running. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`[${this.props.name}]`, error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const retry = () => this.setState({ error: null });
    return (
      <div className={`error-card ${this.props.full ? "full" : ""}`} role="alert">
        <b>{this.props.name} crashed</b>
        <p className="mono">{this.state.error.message}</p>
        <div className="row">
          <button onClick={retry}>Try again</button>
          <button className="primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
