import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { RecordingInfo, RecordingPeek } from "@shared/protocol";
import { api } from "../lib/api";
import { bytes as mb, duration as dur, when } from "../lib/format";
import { withToken } from "../lib/prefs";
import { toast } from "../lib/store";
import { confirm } from "./Dialog";
import { fmtTime } from "./ui";

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

/** `active` pauses the polling while the panel is hidden (it stays mounted so the selection survives a tab switch). */
export const Recordings = memo(function Recordings({ live, currentBase, replayOf, active }: { live: boolean; currentBase?: string; replayOf?: string; active: boolean }) {
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [peek, setPeek] = useState<RecordingPeek | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => api.recordings().then(setList).catch(() => setList((l) => l ?? [])), []);
  useEffect(() => { if (!active) return; void refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, [live, active, refresh]);
  const select = useCallback((id: string | null) => { setSelected(id); setPeek(null); }, []);
  useEffect(() => { if (!selected) return; let stop = false; void api.peekRecording(selected).then((p) => { if (!stop) setPeek(p); }).catch(() => { if (!stop) setPeek(null); }); return () => { stop = true; }; }, [selected]);
  const rows = useMemo(() => (list ?? []).filter((r) => !search || `${r.username} ${r.title ?? ""} ${r.id}`.toLowerCase().includes(search.toLowerCase())), [list, search]);
  const totals = useMemo(() => ({ n: list?.length ?? 0, size: (list ?? []).reduce((a, r) => a + r.sizeBytes, 0), videos: (list ?? []).reduce((a, r) => a + r.videos.length, 0) }), [list]);
  const remove = async (r: RecordingInfo) => {
    const ok = await confirm({ title: `Delete "${r.username} · ${when(r.createdAt)}"?`, body: `${r.eventCount} events${r.videos.length ? ` and ${r.videos.length} video file${r.videos.length > 1 ? "s" : ""} (${mb(r.videos.reduce((a, v) => a + v.sizeBytes, 0))})` : ""}. This cannot be undone.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    setBusy(r.id);
    try { await api.deleteRecording(r.id); if (selected === r.id) select(null); void refresh(); toast({ kind: "info", title: "Recording deleted" }); }
    catch { /* toasted */ } finally { setBusy(null); }
  };
  const replay = async (r: RecordingInfo, simulate = false) => { setBusy(r.id); try { await api.connect("replay", r.id, { simulate }); } catch { /* toasted */ } finally { setBusy(null); } };
  return (
    <div className="recs">
      <div className="recs-toolbar">
        <input className="search" placeholder="search recordings…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="search recordings" />
        <span className="muted mono">{totals.n} sessions · {totals.videos} videos · {mb(totals.size)}</span>
        <button className="icon" onClick={refresh} title="refresh" aria-label="refresh">↻</button>
      </div>
      <div className="recs-list">
        {list === null && <div className="empty">Loading…</div>}
        {list !== null && rows.length === 0 && <div className="empty">No recordings yet. Every connected session is recorded here.</div>}
        {rows.map((r) => {
          const isCurrent = !!currentBase && currentBase === r.id;
          const isReplaying = replayOf === r.id;
          const open = selected === r.id;
          return (
            <div key={r.id} className={`rec ${open ? "on" : ""} ${isCurrent ? "current" : ""}`}>
              <button className="rec-head as-row" onClick={() => select(open ? null : r.id)} aria-expanded={open}>
                <span className="rec-user">@{r.username}</span>
                {r.title && <span className="rec-title">{r.title}</span>}
                <span className="grow" />
                {isCurrent && <span className="badge mod">recording now</span>}
                {isReplaying && <span className="badge add">replaying</span>}
                {r.videos.length > 0 && <span className="rec-chip has-video" title={r.videos.map((v) => `${v.file} · ${dur(v.durationSec)}`).join("\n")}>🎥 {r.videos.length > 1 ? `${r.videos.length} clips · ` : ""}{dur(r.videos.reduce((a, v) => a + v.durationSec, 0))}</span>}
              </button>
              <div className="rec-meta mono">
                <span>{when(r.createdAt)}</span><span>{dur(r.durationSec)}</span><span>{r.chatCount} chat</span><span>{r.transcriptCount} lines</span><span>{mb(r.sizeBytes)}</span>
              </div>
              {open && (
                <div className="rec-detail">
                  {peek ? <Timeline peek={peek} durationSec={r.durationSec} videos={r.videos} t0={peek.chat[0]?.ts && peek.transcript[0]?.ts ? Math.min(peek.chat[0].ts, peek.transcript[0].ts) : (peek.chat[0]?.ts ?? peek.transcript[0]?.ts ?? r.createdAt)} /> : <div className="skeleton" />}
                  {r.videos.length > 0 && (
                    <ul className="rec-videos">
                      {r.videos.map((v) => <li key={v.file}><span className="mono">🎥 {v.file}</span><span className="muted mono">{fmtTime(v.startTs)} → {v.endTs ? fmtTime(v.endTs) : "…"} · {dur(v.durationSec)} · {mb(v.sizeBytes)}</span><a className="icon" href={withToken(`/recordings/${v.file}`)} download title="download video">⤓</a></li>)}
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
                    <button className="primary" disabled={live || busy === r.id} onClick={() => replay(r)} title={live ? "disconnect first" : "replay this session (events only; jev is called unless dry run is on in Settings)"}>▶ Replay</button>
                    {r.videos.length > 0 && <button disabled={live || busy === r.id} onClick={() => replay(r, true)} title="play the video through the real media pipeline as if it were live (dev)">⚙ Simulate live</button>}
                    <a className="icon" href={withToken(`/recordings/${r.id}.jsonl`)} download title="download events">⤓ events</a>
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
});
