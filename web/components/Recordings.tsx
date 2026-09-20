import { useEffect, useMemo, useState } from "react";
import type { RecordingInfo, RecordingPeek } from "@shared/protocol";
import { api } from "../useSocket";
import { fmtTime } from "./ui";

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const dur = (s?: number) => (s === undefined ? "—" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const when = (ts: number) => new Date(ts).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Timeline({ peek, durationSec, videos, t0 }: { peek: RecordingPeek; durationSec?: number; videos: RecordingInfo["videos"]; t0: number }) {
  const minutes = Math.max(1, Math.ceil((durationSec ?? 60) / 60));
  const max = Math.max(1, ...peek.timeline.map((b) => b.chat + b.transcript));
  return (
    <div className="rec-timeline" title="activity per minute: chat (blue) and host speech (orange); bars below show where video exists">
      <div className="rec-bars" style={{ gridTemplateColumns: `repeat(${minutes}, 1fr)` }}>
        {Array.from({ length: minutes }, (_, i) => { const b = peek.timeline.find((x) => x.t === i); return <span key={i} className="rec-bar"><i className="chat" style={{ height: `${((b?.chat ?? 0) / max) * 100}%` }} /><i className="talk" style={{ height: `${((b?.transcript ?? 0) / max) * 100}%` }} /></span>; })}
      </div>
      <div className="rec-videos-track">
        {videos.map((v) => { const total = minutes * 60_000; const left = Math.max(0, (v.startTs - t0) / total) * 100; const width = Math.min(100 - left, (((v.endTs ?? v.startTs) - v.startTs) / total) * 100); return <span key={v.file} className="rec-video-span" style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }} title={`${v.file} · ${dur(v.durationSec)} · ${mb(v.sizeBytes)}`} />; })}
      </div>
    </div>
  );
}

export function Recordings({ live, currentBase, replayOf }: { live: boolean; currentBase?: string; replayOf?: string }) {
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [peek, setPeek] = useState<RecordingPeek | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => api.recordings().then(setList).catch(() => setList([]));
  useEffect(() => { void refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, [live]);
  useEffect(() => { if (!selected) { setPeek(null); return; } setPeek(null); void api.peekRecording(selected).then(setPeek).catch(() => setPeek(null)); }, [selected]);
  const rows = useMemo(() => (list ?? []).filter((r) => !search || `${r.username} ${r.title ?? ""} ${r.id}`.toLowerCase().includes(search.toLowerCase())), [list, search]);
  const totals = useMemo(() => ({ n: list?.length ?? 0, size: (list ?? []).reduce((a, r) => a + r.sizeBytes, 0), videos: (list ?? []).reduce((a, r) => a + r.videos.length, 0) }), [list]);
  const sel = rows.find((r) => r.id === selected) ?? null;
  const remove = async (r: RecordingInfo) => {
    if (!window.confirm(`Delete "${r.username} · ${when(r.createdAt)}"?\n${r.eventCount} events${r.videos.length ? ` and ${r.videos.length} video file${r.videos.length > 1 ? "s" : ""} (${mb(r.videos.reduce((a, v) => a + v.sizeBytes, 0))})` : ""}. This cannot be undone.`)) return;
    setBusy(r.id);
    const res = await api.deleteRecording(r.id);
    setBusy(null);
    if (res.ok) { if (selected === r.id) setSelected(null); void refresh(); } else window.alert(res.error ?? "delete failed");
  };
  return (
    <div className="recs">
      <div className="recs-toolbar">
        <input className="search" placeholder="search recordings…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="search recordings" />
        <span className="muted mono">{totals.n} sessions · {totals.videos} videos · {mb(totals.size)}</span>
        <button className="icon" onClick={refresh} title="refresh">↻</button>
      </div>
      <div className="recs-list">
        {list === null && <div className="empty">Loading…</div>}
        {list !== null && rows.length === 0 && <div className="empty">No recordings yet. Every connected session is recorded here.</div>}
        {rows.map((r) => {
          const isCurrent = !!currentBase && currentBase === r.id;
          const isReplaying = replayOf === r.id;
          return (
            <div key={r.id} className={`rec ${selected === r.id ? "on" : ""} ${isCurrent ? "current" : ""}`} onClick={() => setSelected(selected === r.id ? null : r.id)}>
              <div className="rec-head">
                <span className="rec-user">@{r.username}</span>
                {r.title && <span className="rec-title">{r.title}</span>}
                <span className="grow" />
                {isCurrent && <span className="badge mod">recording now</span>}
                {isReplaying && <span className="badge add">replaying</span>}
                {r.videos.length > 0 && <span className="rec-chip has-video" title={r.videos.map((v) => `${v.file} · ${dur(v.durationSec)}`).join("\n")}>🎥 {r.videos.length > 1 ? `${r.videos.length} clips · ` : ""}{dur(r.videos.reduce((a, v) => a + v.durationSec, 0))}</span>}
              </div>
              <div className="rec-meta mono">
                <span>{when(r.createdAt)}</span><span>{dur(r.durationSec)}</span><span>{r.chatCount} chat</span><span>{r.transcriptCount} lines</span><span>{mb(r.sizeBytes)}</span>
              </div>
              {selected === r.id && (
                <div className="rec-detail" onClick={(e) => e.stopPropagation()}>
                  {peek ? <Timeline peek={peek} durationSec={r.durationSec} videos={r.videos} t0={peek.chat[0]?.ts && peek.transcript[0]?.ts ? Math.min(peek.chat[0].ts, peek.transcript[0].ts) : (peek.chat[0]?.ts ?? peek.transcript[0]?.ts ?? r.createdAt)} /> : <div className="skeleton" />}
                  {r.videos.length > 0 && (
                    <ul className="rec-videos">
                      {r.videos.map((v) => <li key={v.file}><span className="mono">🎥 {v.file}</span><span className="muted mono">{fmtTime(v.startTs)} → {v.endTs ? fmtTime(v.endTs) : "…"} · {dur(v.durationSec)} · {mb(v.sizeBytes)}</span><a className="icon" href={`/recordings/${v.file}`} download title="download video">⤓</a></li>)}
                    </ul>
                  )}
                  {peek && (
                    <div className="rec-peek">
                      {peek.captions[0] && <p className="rec-caption">🎥 {peek.captions[0].text}</p>}
                      {peek.transcript.length > 0 && <div className="rec-col"><h4>Host</h4>{peek.transcript.slice(0, 6).map((l, i) => <p key={i}><span className="mono q-time">{fmtTime(l.ts)}</span> {l.text}</p>)}</div>}
                      {peek.chat.length > 0 && <div className="rec-col"><h4>Chat</h4>{peek.chat.slice(0, 8).map((m, i) => <p key={i}><b>{m.nickname || m.handle}</b> {m.text}</p>)}</div>}
                    </div>
                  )}
                  <div className="rec-actions">
                    <button className="primary" disabled={live} onClick={() => api.connect("replay", r.events)} title={live ? "disconnect first" : "replay this session"}>▶ Replay</button>
                    <a className="icon" href={`/recordings/${r.id}.jsonl`} download title="download events">⤓ events</a>
                    <span className="grow" />
                    <button className="icon danger" disabled={busy === r.id || isCurrent || isReplaying} title={isReplaying ? "disconnect first" : isCurrent ? "session in progress" : "delete this recording"} onClick={() => remove(r)}>{busy === r.id ? "…" : "🗑 delete"}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
