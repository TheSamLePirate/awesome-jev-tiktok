import { useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, ReplayInfo } from "@shared/protocol";
import { api } from "../useSocket";

const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Full-width replay scrubber: extent, playhead, activity, video coverage, flags. Click or ←/→ to seek. */
export function ReplayTimeline({ replay, highlights }: { replay: ReplayInfo; highlights: Highlight[] }) {
  const total = Math.max(1, replay.tEnd - replay.t0);
  const [now, setNow] = useState(Date.now());
  const [hover, setHover] = useState<number | null>(null);
  const [seeking, setSeeking] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => { let raf = 0; const loop = () => { setNow(Date.now()); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf); }, []);
  useEffect(() => { setSeeking(null); }, [replay.startedAt]);

  const pos = Math.min(total, replay.offsetMs + (now - replay.startedAt));
  const frac = pos / total;
  const maxB = useMemo(() => Math.max(1, ...replay.buckets.map((b) => b.chat + b.transcript)), [replay.buckets]);
  const marks = useMemo(() => highlights.filter((h) => h.ts >= replay.startedAt - 1000).map((h) => ({ id: h.id, frac: Math.min(1, Math.max(0, (replay.offsetMs + (h.ts - replay.startedAt)) / total)), kind: h.kind, label: h.flags.map((f) => f.label).join(", ") })), [highlights, replay, total]);

  const fracAt = (clientX: number) => { const r = track.current?.getBoundingClientRect(); if (!r) return 0; return Math.min(1, Math.max(0, (clientX - r.left) / r.width)); };
  const seek = (f: number) => { const ms = Math.round(f * total); setSeeking(ms); void api.seekReplay(ms); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); seek(Math.max(0, pos - 10_000) / total); }
      if (e.key === "ArrowRight") { e.preventDefault(); seek(Math.min(total, pos + 10_000) / total); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos, total]);

  const shown = seeking ?? pos;
  const hoverMs = hover !== null ? hover * total : null;
  return (
    <div className={`replaybar ${seeking !== null ? "seeking" : ""}`} role="region" aria-label="replay timeline">
      <div className="rb-left">
        <span className="rb-tag"><i />REPLAY</span>
        <span className="rb-who" title={replay.title}>@{replay.username}{replay.title ? <span className="rb-title"> · {replay.title}</span> : null}</span>
      </div>
      <span className="rb-time rb-elapsed" title="elapsed">{mmss(shown)}</span>
      <div className="rb-track" ref={track}
        onMouseMove={(e) => setHover(fracAt(e.clientX))} onMouseLeave={() => setHover(null)}
        onClick={(e) => seek(fracAt(e.clientX))} title="click to seek · ← → 10 s">
        <div className="rb-bars">
          {replay.buckets.map((b, i) => <span key={i} className="rb-bucket"><i className="chat" style={{ height: `${(b.chat / maxB) * 100}%` }} /><i className="talk" style={{ height: `${(b.transcript / maxB) * 100}%` }} /></span>)}
        </div>
        <div className="rb-video">
          {replay.segments.map((sg) => <span key={sg.url} style={{ left: `${((sg.startTs - replay.t0) / total) * 100}%`, width: `${Math.max(0.3, ((sg.endTs - sg.startTs) / total) * 100)}%` }} title="video available" />)}
        </div>
        <div className="rb-played" style={{ width: `${(shown / total) * 100}%` }} />
        {marks.map((m) => <span key={m.id} className={`rb-mark ${m.kind}`} style={{ left: `${m.frac * 100}%` }} title={m.label} />)}
        <div className="rb-head" style={{ left: `${(shown / total) * 100}%` }}><span className="rb-knob" /></div>
        {hoverMs !== null && <div className="rb-tip" style={{ left: `${hover! * 100}%` }}>{mmss(hoverMs)}<small>{clock(replay.t0 + hoverMs)}</small></div>}
      </div>
      <span className="rb-time rb-remaining" title="remaining">−{mmss(total - shown)}</span>
      <div className="rb-right">
        <span className="rb-total"><small>total</small>{mmss(total)}</span>
        <span className="rb-total"><small>at</small>{clock(replay.t0 + shown)}</span>
        <span className="rb-pct">{Math.round(frac * 100)}%</span>
      </div>
    </div>
  );
}
