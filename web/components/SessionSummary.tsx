import { memo } from "react";
import type { Highlight, SessionSummary as Summary } from "@shared/protocol";
import { csvRow, download, duration, money, when } from "../lib/format";
import { useT } from "../i18n";

const M = {
  en: { label: "last session summary", ended: "■ Session ended", duration: "duration", flags: "flags", chat: "chat", speech: "speech", lines: " lines", peak: "peak viewers", spend: "spend", firedMost: "Fired most:", replay: "▶ Replay this session", csv: "⤓ flags CSV", md: "⤓ summary .md" },
  fr: { label: "résumé de la dernière session", ended: "■ Session terminée", duration: "durée", flags: "signalements", chat: "chat", speech: "parole", lines: " lignes", peak: "pic de spectateurs", spend: "dépense", firedMost: "Le plus déclenché :", replay: "▶ Revoir cette session", csv: "⤓ CSV des signalements", md: "⤓ résumé .md" },
};

/** What the last session looked like, shown in the middle column instead of a blank console. */
export const SessionSummary = memo(function SessionSummary({ s, highlights, onReplay }: { s: Summary; highlights: Highlight[]; onReplay?: (id: string) => void }) {
  const t = useT(M);
  const secs = Math.round((s.endedAt - s.startedAt) / 1000);
  const mine = highlights.filter((h) => h.sessionId === s.sessionId);
  const exportCsv = () => {
    const rows = [csvRow(["ts", "kind", "severity", "flags", "text", "pinned", "resolved"]), ...mine.map((h) => csvRow([new Date(h.ts).toISOString(), h.kind, h.severity ?? "", h.flags.map((f) => f.label).join("; "), h.message ? `${h.message.handle}: ${h.message.text}` : h.transcript ? h.transcript.lines.map((l) => l.text).join(" ") : h.scene?.text ?? "", h.pinned, h.resolved]))];
    download(`jev-${s.sessionId}-flags.csv`, rows.join("\r\n"), "text/csv");
  };
  const exportMd = () => {
    const lines = [`# ${s.username}${s.title ? ` · ${s.title}` : ""}`, "", `${when(s.startedAt)} → ${when(s.endedAt)} (${duration(secs)}) · ended: ${s.reason}`, "", `- Flags: ${s.highlights} (${s.warnings} warnings)`, `- Chat: ${s.chatCount} messages · Speech: ${s.transcriptCount} lines · Peak viewers: ${s.peakViewers}`, `- Spend: ${money(s.spend)}`, s.topFired.length ? `- Fired most: ${s.topFired.map((t) => `${t.label} (${t.count})`).join(", ")}` : "", "", "## Flags", ...mine.map((h) => `- ${new Date(h.ts).toLocaleTimeString()} · ${h.flags.map((f) => f.label).join(", ")} · ${h.message ? `${h.message.handle}: ${h.message.text}` : h.transcript ? h.transcript.lines.map((l) => l.text).join(" ") : h.scene?.text ?? ""}`)];
    download(`jev-${s.sessionId}.md`, lines.join("\n"), "text/markdown");
  };
  return (
    <section className="summary panel" aria-label={t("label")}>
      <header className="panel-title"><span>{t("ended")}</span><span className="muted">{s.reason}</span><span className="grow" /><span className="muted mono">{when(s.endedAt)}</span></header>
      <div className="summary-grid">
        <div className="kpi"><small>{t("duration")}</small><b>{duration(secs)}</b></div>
        <div className="kpi"><small>{t("flags")}</small><b>{s.highlights}{s.warnings ? <i> · {s.warnings} ⚠</i> : null}</b></div>
        <div className="kpi"><small>{t("chat")}</small><b>{s.chatCount}</b></div>
        <div className="kpi"><small>{t("speech")}</small><b>{s.transcriptCount}<i>{t("lines")}</i></b></div>
        <div className="kpi"><small>{t("peak")}</small><b>{s.peakViewers}</b></div>
        <div className="kpi"><small>{t("spend")}</small><b>{money(s.spend)}</b></div>
      </div>
      {s.topFired.length > 0 && <p className="summary-top">{t("firedMost")} {s.topFired.map((t) => <span key={t.id} className="chip">{t.label} · {t.count}</span>)}</p>}
      <div className="row">
        {s.recording && onReplay && <button onClick={() => onReplay(s.recording!)}>{t("replay")}</button>}
        <button className="chip-btn" onClick={exportCsv} disabled={!mine.length}>{t("csv")}</button>
        <button className="chip-btn" onClick={exportMd}>{t("md")}</button>
      </div>
    </section>
  );
});
