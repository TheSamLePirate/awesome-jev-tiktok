import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CostTotals, LogActor, LogEntry } from "@shared/protocol";
import { csvRow, download, money, tok } from "../lib/format";
import { useT } from "../i18n";
import { fmtTime, useNow } from "./ui";

const M = {
  en: {
    actorJev: "jev", actorGlm: "GLM", actorVision: "vision", actorSpeech: "speech", actorSystem: "system",
    totalTitle: "{calls} calls · {errors} errors · {tokens} tokens", calls: "{n} calls", err: "{n} err", tok: "{n} tok", p50: "p50 {n} ms",
    session: "Σ session", perHour: "≈ {x}/h", estTitle: "Deepgram minutes are estimated from list price", est: "{x} est.", bootTitle: "since the server started", boot: "{x} since boot",
    errors: "errors", filterPh: "filter…", filter: "filter log", exportCsv: "export CSV", csv: "⤓ csv",
    time: "time", who: "who", what: "what", ms: "ms", tokHead: "tok", cost: "cost", inOut: "{in} in · {out} out",
    empty: "No activity yet.", newest: "newest ↓",
  },
  fr: {
    actorJev: "jev", actorGlm: "GLM", actorVision: "vision", actorSpeech: "parole", actorSystem: "système",
    totalTitle: "{calls} appels · {errors} erreurs · {tokens} tokens", calls: "{n} appels", err: "{n} err", tok: "{n} tok", p50: "p50 {n} ms",
    session: "Σ session", perHour: "≈ {x}/h", estTitle: "Les minutes Deepgram sont estimées au tarif public", est: "{x} est.", bootTitle: "depuis le démarrage du serveur", boot: "{x} depuis le démarrage",
    errors: "erreurs", filterPh: "filtrer…", filter: "filtrer le journal", exportCsv: "exporter en CSV", csv: "⤓ csv",
    time: "heure", who: "qui", what: "quoi", ms: "ms", tokHead: "tok", cost: "coût", inOut: "{in} entrée · {out} sortie",
    empty: "Pas encore d'activité.", newest: "plus récent ↓",
  },
};
type MK = keyof typeof M.en;

const ACTORS: { id: LogActor; label: MK; icon: string }[] = [
  { id: "jev", label: "actorJev", icon: "◎" },
  { id: "glm", label: "actorGlm", icon: "✎" },
  { id: "vision", label: "actorVision", icon: "🎥" },
  { id: "deepgram", label: "actorSpeech", icon: "🎙" },
  { id: "system", label: "actorSystem", icon: "⚙" },
];

/** Totals come from the server (the same numbers as the header); the per-actor call counts are from the visible rows. */
const Totals = memo(function Totals({ entries, totals, now }: { entries: LogEntry[]; totals: CostTotals; now: number }) {
  const t = useT(M);
  const per = useMemo(() => {
    const acc: Record<LogActor, { calls: number; errors: number; tokens: number; lat: number[] }> = { jev: { calls: 0, errors: 0, tokens: 0, lat: [] }, glm: { calls: 0, errors: 0, tokens: 0, lat: [] }, vision: { calls: 0, errors: 0, tokens: 0, lat: [] }, deepgram: { calls: 0, errors: 0, tokens: 0, lat: [] }, system: { calls: 0, errors: 0, tokens: 0, lat: [] } };
    for (const e of entries) { const a = acc[e.actor] ?? acc.system; a.calls++; if (!e.ok) a.errors++; a.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0); if (e.latencyMs !== undefined) a.lat.push(e.latencyMs); }
    return acc;
  }, [entries]);
  const total = totals.session;
  const first = entries.find((e) => e.sessionId)?.ts ?? entries[0]?.ts ?? now;
  const hours = Math.max(1 / 60, (now - first) / 3_600_000);
  const p50 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
  return (
    <div className="log-totals">
      {ACTORS.filter((a) => a.id !== "system").map((a) => {
        const p = per[a.id];
        const cost = totals.byActor[a.id] ?? 0;
        const share = total > 0 ? cost / total : 0;
        return (
          <div key={a.id} className={`log-total ${a.id}`} title={t("totalTitle", { calls: p.calls, errors: p.errors, tokens: tok(p.tokens) })}>
            <div className="log-total-head"><span className="log-actor">{a.icon} {t(a.label)}</span><span className="grow" /><b className="mono">{money(cost)}</b></div>
            <div className="log-share"><span style={{ width: `${share * 100}%` }} /></div>
            <div className="log-total-meta mono"><span>{t("calls", { n: p.calls })}</span>{p.errors > 0 && <span className="error">{t("err", { n: p.errors })}</span>}<span>{t("tok", { n: tok(p.tokens) })}</span>{p50(p.lat) !== undefined && <span>{t("p50", { n: p50(p.lat)! })}</span>}</div>
          </div>
        );
      })}
      <div className="log-total rate">
        <div className="log-total-head"><span className="log-actor">{t("session")}</span><span className="grow" /><b className="mono">{money(total)}</b></div>
        <div className="log-total-meta mono"><span>{t("perHour", { x: money(total / hours) })}</span>{totals.estimated > 0 && <span title={t("estTitle")}>{t("est", { x: money(totals.estimated) })}</span>}<span title={t("bootTitle")}>{t("boot", { x: money(totals.boot) })}</span></div>
      </div>
    </div>
  );
});

export const ActivityLog = memo(function ActivityLog({ entries, totals }: { entries: LogEntry[]; totals: CostTotals }) {
  const t = useT(M);
  const [actors, setActors] = useState<Set<LogActor>>(new Set());
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [pinned, setPinned] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(5000);
  const toggle = (a: LogActor) => setActors((cur) => { const n = new Set(cur); n.has(a) ? n.delete(a) : n.add(a); return n; });
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => (!actors.size || actors.has(e.actor)) && (!errorsOnly || !e.ok) && (!q || `${e.kind} ${e.detail}`.toLowerCase().includes(q))).slice(-400);
  }, [entries, actors, errorsOnly, search]);
  useEffect(() => { const el = ref.current; if (el && pinned) el.scrollTop = el.scrollHeight; }, [list.length, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  const exportCsv = () => {
    const rows = [csvRow(["ts", "session", "actor", "kind", "ok", "latency_ms", "input_tokens", "output_tokens", "cost_usd", "cost_kind", "questions", "detail"]), ...entries.map((e) => csvRow([new Date(e.ts).toISOString(), e.sessionId ?? "", e.actor, e.kind, e.ok, e.latencyMs ?? "", e.inputTokens ?? "", e.outputTokens ?? "", e.cost ?? "", e.costKind ?? "", e.questions ?? "", e.detail]))];
    download(`awesome-jev-log-${new Date().toISOString().slice(0, 19)}.csv`, rows.join("\r\n"), "text/csv");
  };
  return (
    <div className="activity">
      <Totals entries={entries} totals={totals} now={now} />
      <div className="log-toolbar">
        {ACTORS.map((a) => <button key={a.id} className={`chip-btn ${actors.has(a.id) ? "on" : ""}`} aria-pressed={actors.has(a.id)} onClick={() => toggle(a.id)}>{a.icon} {t(a.label)}</button>)}
        <span className="sep" />
        <button className={`chip-btn ${errorsOnly ? "on" : ""}`} aria-pressed={errorsOnly} onClick={() => setErrorsOnly((v) => !v)}>{t("errors")}</button>
        <input className="search" name="log-filter" placeholder={t("filterPh")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("filter")} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" />
        <button className="icon" onClick={exportCsv} title={t("exportCsv")}>{t("csv")}</button>
      </div>
      <div className="log-list" ref={ref} onScroll={onScroll} role="log">
        <div className="log-row head"><span>{t("time")}</span><span>{t("who")}</span><span>{t("what")}</span><span className="r">{t("ms")}</span><span className="r">{t("tokHead")}</span><span className="r">{t("cost")}</span></div>
        {list.map((e) => (
          <div key={e.id} className={`log-row ${e.actor} ${e.ok ? "" : "err"}`} title={e.detail}>
            <span className="mono log-time">{fmtTime(e.ts)}</span>
            <span className={`log-who ${e.actor}`}>{ACTORS.find((a) => a.id === e.actor)?.icon} {e.actor}</span>
            <span className="log-what"><span className="log-kind">{e.kind}</span>{e.questions ? <span className="log-q mono">{e.questions}q</span> : null}<span className="log-detail">{e.detail}</span></span>
            <span className="mono r">{e.latencyMs ?? ""}</span>
            <span className="mono r" title={t("inOut", { in: e.inputTokens ?? 0, out: e.outputTokens ?? 0 })}>{e.inputTokens !== undefined ? tok((e.inputTokens ?? 0) + (e.outputTokens ?? 0)) : ""}</span>
            <span className={`mono r ${e.costKind === "estimated" ? "muted" : ""}`} title={e.costKind}>{e.cost ? `${money(e.cost)}${e.costKind === "estimated" ? "~" : ""}` : ""}</span>
          </div>
        ))}
        {list.length === 0 && <div className="empty">{t("empty")}</div>}
      </div>
      {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>{t("newest")}</button>}
    </div>
  );
});
