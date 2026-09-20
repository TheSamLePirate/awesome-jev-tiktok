import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Director } from "./Director";

const view = new URLSearchParams(location.search).get("view") ?? (location.hash === "#/director" ? "director" : "");
createRoot(document.getElementById("root")!).render(view === "director" ? <Director /> : <App />);
