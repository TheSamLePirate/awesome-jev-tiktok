import { useEffect, useMemo, useRef, useState } from "react";
import type { LogActor, LogEntry } from "@shared/protocol";
import { fmtTime, useNow } from "./ui";

const ACTORS: { id: LogActor; label: string; icon: string }[] = [
  { id: "jev", label: "jev", icon: "◎" },
  { id: "glm", label: "GLM", icon: "✎" },
  { id: "vision", label: "vision", icon: "🎥" },
  { id: "system", label: "system", icon: "⚙" },
];

const money = (n: number) => (n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(5)}` : "—");
const tok = (n?: number) => (n === undefined ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Totals({ entries, now }: { entries: LogEntry[]; now: number }) {
  const per = useMemo(() => {
    const t: Record<LogActor, { calls: number; errors: number; tokens: number; cost: number; lat: number[] }> = { jev: { calls: 0, errors: 0, tokens: 0, cost: 0, lat: [] }, glm: { calls: 0, errors: 0, tokens: 0, cost: 0, lat: [] }, vision: { calls: 0, errors: 0, tokens: 0, cost: 0, lat: [] }, system: { calls: 0, errors: 0, tokens: 0, cost: 0, lat: [] } };
    for (const e of entries) { const a = t[e.actor]; a.calls++; if (!e.ok) a.errors++; a.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0); a.cost += e.cost ?? 0; if (e.latencyMs !== undefined) a.lat.push(e.latencyMs); }
    return t;
  }, [entries]);
  const total = per.jev.cost + per.glm.cost + per.vision.cost;
  const first = entries[0]?.ts ?? now;
  const hours = Math.max(1 / 60, (now - first) / 3_600_000);
  const rate = total / hours;
  const p50 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
  return (
    <div className="log-totals">
      {ACTORS.filter((a) => a.id !== "system").map((a) => {
        const t = per[a.id];
        const share = total > 0 ? t.cost / total : 0;
        return (
          <div key={a.id} className={`log-total ${a.id}`} title={`${t.calls} calls · ${t.errors} errors · ${tok(t.tokens)} tokens`}>
            <div className="log-total-head"><span className="log-actor">{a.icon} {a.label}</span><span className="grow" /><b className="mono">{money(t.cost)}</b></div>
            <div className="log-share"><span style={{ width: `${share * 100}%` }} /></div>
            <div className="log-total-meta mono"><span>{t.calls} calls</span>{t.errors > 0 && <span className="error">{t.errors} err</span>}<span>{tok(t.tokens)} tok</span>{p50(t.lat) !== undefined && <span>p50 {p50(t.lat)} ms</span>}</div>
          </div>
        );
      })}
      <div className="log-total rate">
        <div className="log-total-head"><span className="log-actor">Σ session</span><span className="grow" /><b className="mono">{money(total)}</b></div>
        <div className="log-total-meta mono"><span>≈ {money(rate)}/h</span><span>{entries.length} entries</span></div>
      </div>
    </div>
  );
}

export function ActivityLog({ entries }: { entries: LogEntry[] }) {
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
    const rows = [["ts", "actor", "kind", "ok", "latency_ms", "input_tokens", "output_tokens", "cost_usd", "questions", "detail"], ...entries.map((e) => [new Date(e.ts).toISOString(), e.actor, e.kind, e.ok, e.latencyMs ?? "", e.inputTokens ?? "", e.outputTokens ?? "", e.cost ?? "", e.questions ?? "", JSON.stringify(e.detail)])];
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `awesome-jev-log-${new Date().toISOString().slice(0, 19)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <div className="activity">
      <Totals entries={entries} now={now} />
      <div className="log-toolbar">
        {ACTORS.map((a) => <button key={a.id} className={`chip-btn ${actors.has(a.id) ? "on" : ""}`} onClick={() => toggle(a.id)}>{a.icon} {a.label}</button>)}
        <span className="sep" />
        <button className={`chip-btn ${errorsOnly ? "on" : ""}`} onClick={() => setErrorsOnly((v) => !v)}>errors</button>
        <input className="search" placeholder="filter…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="filter log" />
        <button className="icon" onClick={exportCsv} title="export CSV">⤓ csv</button>
      </div>
      <div className="log-list" ref={ref} onScroll={onScroll} role="log">
        <div className="log-row head"><span>time</span><span>who</span><span>what</span><span className="r">ms</span><span className="r">tok</span><span className="r">cost</span></div>
        {list.map((e) => (
          <div key={e.id} className={`log-row ${e.actor} ${e.ok ? "" : "err"}`} title={e.detail}>
            <span className="mono log-time">{fmtTime(e.ts)}</span>
            <span className={`log-who ${e.actor}`}>{ACTORS.find((a) => a.id === e.actor)?.icon} {e.actor}</span>
            <span className="log-what"><span className="log-kind">{e.kind}</span>{e.questions ? <span className="log-q mono">{e.questions}q</span> : null}<span className="log-detail">{e.detail}</span></span>
            <span className="mono r">{e.latencyMs ?? ""}</span>
            <span className="mono r" title={`${e.inputTokens ?? 0} in · ${e.outputTokens ?? 0} out`}>{e.inputTokens !== undefined ? tok((e.inputTokens ?? 0) + (e.outputTokens ?? 0)) : ""}</span>
            <span className="mono r">{e.cost ? money(e.cost) : ""}</span>
          </div>
        ))}
        {list.length === 0 && <div className="empty">No activity yet.</div>}
      </div>
      {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>newest ↓</button>}
    </div>
  );
}
