import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";
import { App } from "./App";
import { Director } from "./Director";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./components/Login";
import { api } from "./lib/api";
import { dispatch, startSocket } from "./lib/store";
import { forgetLegacyToken, legacyToken, stripTokenFromUrl, urlToken } from "./lib/prefs";

const view = new URLSearchParams(location.search).get("view") ?? (location.hash === "#/director" ? "director" : "");
/** Exported so a test can unmount the tree it mounted. */
export const root = createRoot(document.getElementById("root")!);
const renderApp = () => {
  startSocket("");
  root.render(
    <StrictMode>
      <ErrorBoundary name={view === "director" ? "Director" : "Console"} full>
        {view === "director" ? <Director /> : <App />}
      </ErrorBoundary>
    </StrictMode>,
  );
};
const renderLogin = (reason?: string) => root.render(<StrictMode><Login reason={reason} onDone={renderApp} /></StrictMode>);

/**
 * Boot: a token in the link (or one an older console stored) is exchanged for a session cookie and dropped from the
 * URL; then the server says whether it is protected and whether this browser is signed in. Unreachable server: the
 * app boots anyway and shows "server unreachable".
 */
export const boot = async () => {
  const fromUrl = urlToken(), fromStorage = legacyToken();
  if (fromUrl || fromStorage) {
    const ok = await api.login(fromUrl || fromStorage).then(() => true).catch(() => false);
    stripTokenFromUrl();
    forgetLegacyToken();
    dispatch({ type: "auth", protected: true });
    if (!ok && fromUrl) return renderLogin("The token in the link was refused.");
  }
  const a = await api.auth().catch(() => null);
  if (a) dispatch({ type: "auth", protected: a.required });
  if (a && a.required && !a.authenticated) return renderLogin();
  renderApp();
};
void boot();
