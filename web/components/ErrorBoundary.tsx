import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../i18n";
import { COMMON } from "../i18n/common";

const M = { en: { crashed: "{name} crashed", retry: "Try again" }, fr: { crashed: "{name} a planté", retry: "Réessayer" } };

/** The card itself is a function component, so it can follow the language (a class cannot use hooks). */
function ErrorCard({ name, message, full, retry }: { name: string; message: string; full?: boolean; retry: () => void }) {
  const t = useT(M), tc = useT(COMMON);
  return (
    <div className={`error-card ${full ? "full" : ""}`} role="alert">
      <b>{t("crashed", { name })}</b>
      <p className="mono">{message}</p>
      <div className="row">
        <button onClick={retry}>{t("retry")}</button>
        <button className="primary" onClick={() => location.reload()}>{tc("reload")}</button>
      </div>
    </div>
  );
}

interface Props { name: string; children: ReactNode; /** Compact card for panels; full page for the root */ full?: boolean }
interface State { error: Error | null }

/** A crash in one panel shows an error card there; the rest of the console (and the video) keeps running. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`[${this.props.name}]`, error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <ErrorCard name={this.props.name} message={this.state.error.message} full={this.props.full} retry={() => this.setState({ error: null })} />;
  }
}
