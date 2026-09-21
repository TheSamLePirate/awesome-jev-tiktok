import { locale } from "../i18n";
import type { JevAnswer } from "@shared/protocol";

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const clock = fmtTime;
export const pct = (n: number) => `${Math.round(n * 100)}%`;
/** First grapheme(s) of a name, emoji-safe. */
export const initials = (name: string) => { const chars = [...name.trim()]; return chars.slice(0, chars[0] && chars[0].length > 1 ? 1 : 2).join("").toUpperCase() || "?"; };
export const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

/** "now", "12s", "3m", "1h" — for relative timestamps that tick. */
export const ago = (ts: number, now: number) => {
  const d = Math.max(0, now - ts) / 1000;
  if (d < 5) return "now";
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
};

export const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
export const money = (n: number) => (n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(5)}` : "—");
export const tok = (n?: number) => (n === undefined ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const bytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
export const duration = (s?: number) => (s === undefined ? "—" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
export const when = (ts: number) => new Date(ts).toLocaleString(locale(), { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Human text of a jev answer: "82%", "spam · 91%", "Hot · 77%". */
export const answerText = (a: JevAnswer) =>
  a.type === "noul" ? pct(a.noul) : a.type === "choice" ? `${a.choice.replace(/_/g, " ")} · ${pct(a.confidence)}` : `${a.legend[String(Math.round(a.score))]?.split(/[:.]/)[0] ?? a.score.toFixed(1)} · ${pct(a.confidence)}`;
/** Shorter variant for overlays. */
export const answerShort = (a: JevAnswer) => (a.type === "noul" ? pct(a.noul) : a.type === "choice" ? a.choice.replace(/_/g, " ") : (a.legend[String(Math.round(a.score))] ?? "").split(/[:.]/)[0]);

export const confidenceOf = (a: JevAnswer) => (a.type === "noul" ? Math.abs(a.noul - 0.5) * 2 : a.confidence);

/** RFC 4180: quote every field, double the quotes inside. */
export const csvRow = (fields: unknown[]) => fields.map((f) => `"${String(f ?? "").replace(/"/g, '""')}"`).join(",");

export const download = (name: string, content: string, type: string) => {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
