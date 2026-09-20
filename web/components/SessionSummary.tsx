import { memo } from "react";
import type { Highlight, SessionSummary as Summary } from "@shared/protocol";
import { csvRow, download, duration, money, when } from "../lib/format";

/** What the last session looked like, shown in the middle column instead of a blank console. */
export const SessionSummary = memo(function SessionSummary({ s, highlights, onReplay }: { s: Summary; highlights: Highlight[]; onReplay?: (id: string) => void }) {
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
    <section className="summary panel" aria-label="last session summary">
      <header className="panel-title"><span>■ Session ended</span><span className="muted">{s.reason}</span><span className="grow" /><span className="muted mono">{when(s.endedAt)}</span></header>
      <div className="summary-grid">
        <div className="kpi"><small>duration</small><b>{duration(secs)}</b></div>
        <div className="kpi"><small>flags</small><b>{s.highlights}{s.warnings ? <i> · {s.warnings} ⚠</i> : null}</b></div>
        <div className="kpi"><small>chat</small><b>{s.chatCount}</b></div>
        <div className="kpi"><small>speech</small><b>{s.transcriptCount}<i> lines</i></b></div>
        <div className="kpi"><small>peak viewers</small><b>{s.peakViewers}</b></div>
        <div className="kpi"><small>spend</small><b>{money(s.spend)}</b></div>
      </div>
      {s.topFired.length > 0 && <p className="summary-top">Fired most: {s.topFired.map((t) => <span key={t.id} className="chip">{t.label} · {t.count}</span>)}</p>}
      <div className="row">
        {s.recording && onReplay && <button onClick={() => onReplay(s.recording!)}>▶ Replay this session</button>}
        <button className="chip-btn" onClick={exportCsv} disabled={!mine.length}>⤓ flags CSV</button>
        <button className="chip-btn" onClick={exportMd}>⤓ summary .md</button>
      </div>
    </section>
  );
});
