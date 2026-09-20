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
import { startSocket } from "./lib/store";
import { authToken } from "./lib/prefs";

const view = new URLSearchParams(location.search).get("view") ?? (location.hash === "#/director" ? "director" : "");
startSocket(authToken());
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary name={view === "director" ? "Director" : "Console"} full>
      {view === "director" ? <Director /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
