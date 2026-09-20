import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, MomentContext, ReplayInfo, SearchHit, SessionTimeline } from "@shared/protocol";
import { api } from "../lib/api";
import { clock, mmss } from "../lib/format";
import { Avatar, Highlighted, Kbd } from "./ui";

export type Mode = { kind: "replay"; replay: ReplayInfo } | { kind: "live"; timeline: SessionTimeline; playingTs: number | null; behindSec: number; reviewTs: number | null };

/** 8 Hz is plenty for a playhead; the browser only repaints the bar, not the whole console. */
const TICK_MS = 125;

/**
 * Full-width session timeline. Live: the DVR window from the first event to now, with a playhead that sits at the
 * live edge or wherever you are reviewing. Replay: the recording's extent and the replay position. Both: activity,
 * video coverage, flag markers, hover clock, click-to-seek, search over chat and speech with go-to.
 * Arrow keys only act when the track has focus or nothing focusable does (never inside inputs, selects or sliders).
 */
export const Timeline = memo(function Timeline({ mode, highlights, onSeek, onLive, onReview, query, onQuery }: { mode: Mode; highlights: Highlight[]; onSeek: (ts: number) => void; onLive: () => void; onReview: (ctx: MomentContext | null, q: string) => void; query: string; onQuery: (q: string) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState<number | null>(null);
  const [kinds, setKinds] = useState<("chat" | "transcript")[]>(["chat", "transcript"]);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(t); }, []);

  const startTs = mode.kind === "replay" ? mode.replay.t0 : mode.timeline.startTs;
  const endTs = mode.kind === "replay" ? mode.replay.tEnd : now;
  const total = Math.max(1000, endTs - startTs);
  const buckets = mode.kind === "replay" ? mode.replay.buckets : mode.timeline.buckets;
  const segments = mode.kind === "replay" ? mode.replay.segments : mode.timeline.segments;
  const dvrStart = mode.kind === "live" ? mode.timeline.dvrStartTs : startTs;
  const posTs = mode.kind === "replay" ? Math.min(endTs, mode.replay.t0 + mode.replay.offsetMs + (now - mode.replay.startedAt)) : (mode.reviewTs ?? mode.playingTs ?? now);
  const frac = Math.min(1, Math.max(0, (posTs - startTs) / total));
  const reviewing = mode.kind === "live" && (mode.reviewTs !== null || mode.behindSec > 8);
  const maxB = useMemo(() => Math.max(1, ...buckets.map((b) => b.chat + b.transcript)), [buckets]);
  // Marks are keyed on a coarse end time so they are not recomputed 8 times a second.
  const coarseEnd = Math.floor(endTs / 5000) * 5000;
  const marks = useMemo(() => highlights.filter((h) => h.ts >= startTs && h.ts <= coarseEnd + 5000).map((h) => ({ id: h.id, frac: (h.ts - startTs) / Math.max(1000, coarseEnd + 5000 - startTs), kind: h.kind, label: h.flags.map((f) => f.label).join(", "), warn: h.severity === "warn" })), [highlights, startTs, coarseEnd]);

  const fracAt = (clientX: number) => { const r = track.current?.getBoundingClientRect(); if (!r) return 0; return Math.min(1, Math.max(0, (clientX - r.left) / r.width)); };
  const seekFrac = (f: number) => onSeek(startTs + f * total);

  // Debounced search over the session. A new query opens the results; the periodic live refresh only updates them.
  const lastQ = useRef("");
  const q = query;
  const liveTick = mode.kind === "live" ? Math.floor(now / 5000) : 0;
  useEffect(() => {
    if (!q.trim()) { lastQ.current = ""; return; }
    const fresh = q !== lastQ.current;
    const t = setTimeout(() => { void api.search(q, kinds).then((h) => { setHits(h); if (fresh) { setActive(0); setOpen(true); lastQ.current = q; } }).catch(() => {}); }, fresh ? 220 : 0);
    return () => clearTimeout(t);
  }, [q, kinds, liveTick]);

  const goTo = async (hit: SearchHit) => {
    setOpen(false);
    // Land just before the words start; chat hits are already on the viewer's clock.
    onSeek(hit.kind === "transcript" ? hit.ts - 1000 : hit.ts);
    const ctx = await api.context(hit.ts).catch(() => null);
    onReview(ctx, q);
  };

  // Keyboard: registered once; the handler reads the latest values through a ref.
  const latest = useRef({ hits, active, posTs, startTs, endTs, mode: mode.kind, goTo, onSeek, onLive });
  useEffect(() => { latest.current = { hits, active, posTs, startTs, endTs, mode: mode.kind, goTo, onSeek, onLive }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = latest.current;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); input.current?.select(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t === input.current) {
        if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
        if (e.key === "ArrowDown" && L.hits?.length) { e.preventDefault(); setActive((a) => Math.min(L.hits!.length - 1, a + 1)); setOpen(true); }
        if (e.key === "ArrowUp" && L.hits?.length) { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
        if (e.key === "Enter" && L.hits?.[L.active]) { e.preventDefault(); void L.goTo(L.hits[L.active]); }
        return;
      }
      if (typing) return;
      const onTrack = t === track.current || t === document.body || t === null;
      if (!onTrack && t && t.closest("input, select, textarea, [role=slider], button")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); L.onSeek(Math.max(L.startTs, L.posTs - 10_000)); }
      if (e.key === "ArrowRight") { e.preventDefault(); L.onSeek(Math.min(L.endTs, L.posTs + 10_000)); }
      if (e.key === "l" && L.mode === "live") L.onLive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hoverMs = hover !== null ? hover * total : null;
  const dvrFrac = Math.min(1, Math.max(0, (dvrStart - startTs) / total));
  return (
    <div className={`replaybar ${mode.kind} ${reviewing ? "reviewing" : ""}`} role="region" aria-label="session timeline">
      <div className="rb-left">
        {mode.kind === "replay"
          ? <span className="rb-tag"><i />REPLAY{mode.replay.dryRun && <small title="no paid call during this replay"> · dry</small>}</span>
          : reviewing ? <button className="rb-tag live-btn" onClick={onLive} title="back to live (l)">⏪ REVIEW · back to live</button> : <span className="rb-tag live"><i className="dot-live" />LIVE</span>}
        {mode.kind === "replay" && <span className="rb-who" title={mode.replay.title}>@{mode.replay.username}{mode.replay.title ? <span className="rb-title"> · {mode.replay.title}</span> : null}</span>}
      </div>
      <span className="rb-time rb-elapsed" title={mode.kind === "live" ? "position in the session" : "elapsed"}>{mmss(posTs - startTs)}</span>
      <div className="rb-track" ref={track} tabIndex={0} role="slider" aria-label="position in the session" aria-valuemin={0} aria-valuemax={Math.round(total / 1000)} aria-valuenow={Math.round((posTs - startTs) / 1000)} aria-valuetext={mmss(posTs - startTs)} onMouseMove={(e) => setHover(fracAt(e.clientX))} onMouseLeave={() => setHover(null)} onClick={(e) => seekFrac(fracAt(e.clientX))} onKeyDown={(e) => { if (e.key === "Home") { e.preventDefault(); onSeek(startTs); } if (e.key === "End") { e.preventDefault(); mode.kind === "live" ? onLive() : onSeek(endTs); } }} title="click to seek · ← → 10 s · Home / End">
        {dvrFrac > 0 && <div className="rb-nodvr" style={{ width: `${dvrFrac * 100}%` }} title="video no longer in the DVR window" />}
        <div className="rb-bars">{buckets.map((b, i) => <span key={i} className="rb-bucket"><i className="chat" style={{ height: `${(b.chat / maxB) * 100}%` }} /><i className="talk" style={{ height: `${(b.transcript / maxB) * 100}%` }} /></span>)}</div>
        <div className="rb-video">{segments.map((sg) => <span key={sg.url} style={{ left: `${((sg.startTs - startTs) / total) * 100}%`, width: `${Math.max(0.3, ((Math.min(sg.endTs, endTs) - sg.startTs) / total) * 100)}%` }} title="video available" />)}</div>
        <div className="rb-played" style={{ width: `${frac * 100}%` }} />
        {marks.map((m) => <span key={m.id} className={`rb-mark ${m.kind} ${m.warn ? "warn" : ""}`} style={{ left: `${m.frac * 100}%` }} title={m.label} />)}
        <div className="rb-head" style={{ left: `${frac * 100}%` }}><span className="rb-knob" /></div>
        {hoverMs !== null && <div className="rb-tip" style={{ left: `${hover! * 100}%` }}>{mmss(hoverMs)}<small>{clock(startTs + hoverMs)}</small></div>}
      </div>
      <span className="rb-time rb-remaining" title={mode.kind === "live" ? "behind live" : "remaining"}>{mode.kind === "live" ? (reviewing ? `−${mmss((now - posTs))}` : "live") : `−${mmss(total - (posTs - startTs))}`}</span>
      <div className="rb-right">
        <span className="rb-total"><small>{mode.kind === "live" ? "session" : "total"}</small>{mmss(total)}</span>
        <span className="rb-total"><small>at</small>{clock(posTs)}</span>
        <div className="rb-search">
          <input ref={input} value={q} onChange={(e) => onQuery(e.target.value)} onFocus={() => hits && setOpen(true)} placeholder="search chat & speech…" aria-label="search the session" />
          <Kbd k="⌘K" />
          {open && hits && q.trim() && (
            <div className="rb-results" onMouseDown={(e) => e.preventDefault()} role="listbox" aria-label="search results" tabIndex={-1}>
              <div className="rb-results-head">
                <span>{hits.length ? `${hits.length} result${hits.length > 1 ? "s" : ""}` : "no match"}</span>
                <span className="grow" />
                {(["chat", "transcript"] as const).map((k) => <button key={k} className={`chip-btn ${kinds.includes(k) ? "on" : ""}`} aria-pressed={kinds.includes(k)} onClick={() => setKinds((cur) => cur.includes(k) ? (cur.length > 1 ? cur.filter((x) => x !== k) : cur) : [...cur, k])}>{k === "chat" ? "💬 chat" : "🎙 speech"}</button>)}
                <button className="icon" onClick={() => setOpen(false)} aria-label="close">✕</button>
              </div>
              <div className="rb-results-list">
                {hits.map((h, i) => (
                  <button key={`${h.ts}-${i}`} role="option" aria-selected={i === active} className={`rb-hit ${i === active ? "on" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => void goTo(h)}>
                    <span className="rb-hit-time mono">{mmss(h.offsetMs)}<small>{clock(h.ts)}</small></span>
                    {h.kind === "chat" ? <Avatar src={h.avatar} name={h.nickname ?? ""} handle={h.handle ?? "?"} size={28} className="sm" /> : <span className="rb-hit-icon">🎙</span>}
                    <span className="rb-hit-body">{h.kind === "chat" && <b>{h.nickname || h.handle} </b>}<Highlighted text={h.text} q={q} /></span>
                    <span className="rb-hit-go">go ↵</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

/** The moment you jumped to: what the host said and what chat typed around it. */
export const ReviewStrip = memo(function ReviewStrip({ ctx, q, live, inDvr, onClose, onLive }: { ctx: MomentContext; q?: string; live: boolean; inDvr: boolean; onClose: () => void; onLive: () => void }) {
  return (
    <div className="review" role="region" aria-label="moment under review">
      <div className="review-head">
        <span className="rb-tag">⏪ {clock(ctx.ts)}</span>
        <span className="muted">±30 s around this moment</span>
        {!inDvr && <span className="badge mod" title="the player keeps only the last DVR window of video; the archive MP4 has it">video not in DVR window</span>}
        {ctx.captions[0] && <span className="review-scene" title={ctx.captions[0].text}>🎥 {ctx.captions[0].text}</span>}
        <span className="grow" />
        {live && <button className="primary" onClick={onLive}>● Back to live</button>}
        <button className="icon" onClick={onClose} aria-label="close review">✕</button>
      </div>
      <div className="review-cols">
        <div className="review-col">
          <h4>🎙 Host</h4>
          {ctx.transcript.length === 0 && <p className="muted">silence</p>}
          {ctx.transcript.map((l, i) => <p key={i} className={Math.abs(l.ts - ctx.ts) < 1500 ? "hit" : ""}><span className="mono q-time">{clock(l.ts)}</span> <Highlighted text={l.text} q={q ?? ""} /></p>)}
        </div>
        <div className="review-col">
          <h4>💬 Chat</h4>
          {ctx.chat.length === 0 && <p className="muted">quiet</p>}
          {ctx.chat.map((m, i) => <p key={i} className={Math.abs(m.ts - ctx.ts) < 1500 ? "hit" : ""}><span className="mono q-time">{clock(m.ts)}</span> <b>{m.nickname || m.handle}</b> <Highlighted text={m.text} q={q ?? ""} /></p>)}
        </div>
      </div>
    </div>
  );
});
