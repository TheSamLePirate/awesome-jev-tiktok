import { useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, MomentContext, ReplayInfo, SearchHit, SessionTimeline } from "@shared/protocol";
import { api } from "../useSocket";
import { Kbd, hue, initials } from "./ui";

const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export type Mode = { kind: "replay"; replay: ReplayInfo } | { kind: "live"; timeline: SessionTimeline; playingTs: number | null; behindSec: number; reviewTs: number | null };

function Highlighted({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

/**
 * Full-width session timeline. Live: the DVR window from the first event to now, with a playhead that sits at the
 * live edge or wherever you are reviewing. Replay: the recording's extent and the replay position. Both: activity,
 * video coverage, flag markers, hover clock, click-to-seek, search over chat and speech with go-to.
 */
export function Timeline({ mode, highlights, onSeek, onLive, onReview }: { mode: Mode; highlights: Highlight[]; onSeek: (ts: number) => void; onLive: () => void; onReview: (ctx: MomentContext | null) => void }) {
  const [now, setNow] = useState(Date.now());
  const [hover, setHover] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<("chat" | "transcript")[]>(["chat", "transcript"]);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { let raf = 0; const loop = () => { setNow(Date.now()); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf); }, []);

  const startTs = mode.kind === "replay" ? mode.replay.t0 : mode.timeline.startTs;
  const endTs = mode.kind === "replay" ? mode.replay.tEnd : now;
  const total = Math.max(1000, endTs - startTs);
  const buckets = mode.kind === "replay" ? mode.replay.buckets : mode.timeline.buckets;
  const segments = mode.kind === "replay" ? mode.replay.segments : mode.timeline.segments;
  const posTs = mode.kind === "replay" ? Math.min(endTs, mode.replay.t0 + mode.replay.offsetMs + (now - mode.replay.startedAt)) : (mode.reviewTs ?? mode.playingTs ?? now);
  const frac = Math.min(1, Math.max(0, (posTs - startTs) / total));
  const reviewing = mode.kind === "live" && (mode.reviewTs !== null || mode.behindSec > 8);
  const maxB = useMemo(() => Math.max(1, ...buckets.map((b) => b.chat + b.transcript)), [buckets]);
  const marks = useMemo(() => highlights.filter((h) => h.ts >= startTs && h.ts <= endTs).map((h) => ({ id: h.id, frac: (h.ts - startTs) / total, kind: h.kind, label: h.flags.map((f) => f.label).join(", ") })), [highlights, startTs, endTs, total]);

  const fracAt = (clientX: number) => { const r = track.current?.getBoundingClientRect(); if (!r) return 0; return Math.min(1, Math.max(0, (clientX - r.left) / r.width)); };
  const seekFrac = (f: number) => onSeek(startTs + f * total);

  // Debounced search over the session file. A new query opens the results; the periodic live refresh only updates them.
  const lastQ = useRef("");
  useEffect(() => {
    if (!q.trim()) { setHits(null); setOpen(false); lastQ.current = ""; return; }
    const fresh = q !== lastQ.current;
    const t = setTimeout(() => { void api.search(q, kinds).then((h) => { setHits(h); if (fresh) { setActive(0); setOpen(true); lastQ.current = q; } }); }, fresh ? 220 : 0);
    return () => clearTimeout(t);
  }, [q, kinds, mode.kind === "live" ? Math.floor(now / 5000) : 0]);

  const goTo = async (hit: SearchHit) => {
    setOpen(false);
    // Land just before the words start; chat hits are already on the viewer's clock.
    onSeek(hit.kind === "transcript" ? hit.ts - 1000 : hit.ts);
    const ctx = await api.context(hit.ts).catch(() => null);
    onReview(ctx);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); input.current?.select(); return; }
      if (t === input.current) {
        if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
        if (e.key === "ArrowDown" && hits?.length) { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); setOpen(true); }
        if (e.key === "ArrowUp" && hits?.length) { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
        if (e.key === "Enter" && hits?.[active]) { e.preventDefault(); void goTo(hits[active]); }
        return;
      }
      if (typing) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); onSeek(Math.max(startTs, posTs - 10_000)); }
      if (e.key === "ArrowRight") { e.preventDefault(); onSeek(Math.min(endTs, posTs + 10_000)); }
      if (e.key === "l" && mode.kind === "live") onLive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hits, active, posTs, startTs, endTs, mode.kind]);

  const hoverMs = hover !== null ? hover * total : null;
  return (
    <div className={`replaybar ${mode.kind} ${reviewing ? "reviewing" : ""}`} role="region" aria-label="session timeline">
      <div className="rb-left">
        {mode.kind === "replay"
          ? <span className="rb-tag"><i />REPLAY</span>
          : reviewing ? <button className="rb-tag live-btn" onClick={onLive} title="back to live (l)">⏪ REVIEW · back to live</button> : <span className="rb-tag live"><i className="dot-live" />LIVE</span>}
        {mode.kind === "replay" && <span className="rb-who" title={mode.replay.title}>@{mode.replay.username}{mode.replay.title ? <span className="rb-title"> · {mode.replay.title}</span> : null}</span>}
      </div>
      <span className="rb-time rb-elapsed" title={mode.kind === "live" ? "position in the session" : "elapsed"}>{mmss(posTs - startTs)}</span>
      <div className="rb-track" ref={track} onMouseMove={(e) => setHover(fracAt(e.clientX))} onMouseLeave={() => setHover(null)} onClick={(e) => seekFrac(fracAt(e.clientX))} title="click to seek · ← → 10 s">
        <div className="rb-bars">{buckets.map((b, i) => <span key={i} className="rb-bucket"><i className="chat" style={{ height: `${(b.chat / maxB) * 100}%` }} /><i className="talk" style={{ height: `${(b.transcript / maxB) * 100}%` }} /></span>)}</div>
        <div className="rb-video">{segments.map((sg) => <span key={sg.url} style={{ left: `${((sg.startTs - startTs) / total) * 100}%`, width: `${Math.max(0.3, ((Math.min(sg.endTs, endTs) - sg.startTs) / total) * 100)}%` }} title="video available" />)}</div>
        <div className="rb-played" style={{ width: `${frac * 100}%` }} />
        {marks.map((m) => <span key={m.id} className={`rb-mark ${m.kind}`} style={{ left: `${m.frac * 100}%` }} title={m.label} />)}
        <div className="rb-head" style={{ left: `${frac * 100}%` }}><span className="rb-knob" /></div>
        {hoverMs !== null && <div className="rb-tip" style={{ left: `${hover! * 100}%` }}>{mmss(hoverMs)}<small>{clock(startTs + hoverMs)}</small></div>}
      </div>
      <span className="rb-time rb-remaining" title={mode.kind === "live" ? "behind live" : "remaining"}>{mode.kind === "live" ? (reviewing ? `−${mmss((now - posTs))}` : "live") : `−${mmss(total - (posTs - startTs))}`}</span>
      <div className="rb-right">
        <span className="rb-total"><small>{mode.kind === "live" ? "session" : "total"}</small>{mmss(total)}</span>
        <span className="rb-total"><small>at</small>{clock(posTs)}</span>
        <div className="rb-search">
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => hits && setOpen(true)} placeholder="search chat & speech…" aria-label="search the session" />
          <Kbd k="⌘K" />
          {open && hits && (
            <div className="rb-results" onMouseDown={(e) => e.preventDefault()}>
              <div className="rb-results-head">
                <span>{hits.length ? `${hits.length} result${hits.length > 1 ? "s" : ""}` : "no match"}</span>
                <span className="grow" />
                {(["chat", "transcript"] as const).map((k) => <button key={k} className={`chip-btn ${kinds.includes(k) ? "on" : ""}`} onClick={() => setKinds((cur) => cur.includes(k) ? (cur.length > 1 ? cur.filter((x) => x !== k) : cur) : [...cur, k])}>{k === "chat" ? "💬 chat" : "🎙 speech"}</button>)}
                <button className="icon" onClick={() => setOpen(false)} aria-label="close">✕</button>
              </div>
              <div className="rb-results-list">
                {hits.map((h, i) => (
                  <button key={`${h.ts}-${i}`} className={`rb-hit ${i === active ? "on" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => void goTo(h)}>
                    <span className="rb-hit-time mono">{mmss(h.offsetMs)}<small>{clock(h.ts)}</small></span>
                    {h.kind === "chat" ? (h.avatar ? <img className="avatar sm" src={h.avatar} alt="" referrerPolicy="no-referrer" /> : <span className="avatar sm" style={{ background: `hsl(${hue(h.handle ?? "")} 45% 35%)` }}>{initials(h.nickname || h.handle || "?")}</span>) : <span className="rb-hit-icon">🎙</span>}
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
}

/** The moment you jumped to: what the host said and what chat typed around it. */
export function ReviewStrip({ ctx, q, live, onClose, onLive }: { ctx: MomentContext; q?: string; live: boolean; onClose: () => void; onLive: () => void }) {
  return (
    <div className="review">
      <div className="review-head">
        <span className="rb-tag">⏪ {clock(ctx.ts)}</span>
        <span className="muted">±30 s around this moment</span>
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
}
