import { useEffect, useMemo, useRef, useState } from "react";
import type { Highlight } from "@shared/protocol";
import { fmtTime } from "./ui";

export function Transcript({ lines, interim, captions, highlights, onOpen }: { lines: { ts: number; text: string }[]; interim: string; captions: { ts: number; text: string }[]; highlights: Highlight[]; onOpen: (h: Highlight) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => { const el = ref.current; if (el && pinned) el.scrollTop = el.scrollHeight; }, [lines.length, interim, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  const cap = captions.at(-1);
  const marks = useMemo(() => {
    const ranges = highlights.filter((h) => h.kind === "transcript" && h.transcript && !h.resolved).map((h) => ({ h, from: h.transcript!.from - 500, to: h.transcript!.to + 500 }));
    const m = new Map<number, Highlight>();
    for (const l of lines) { const r = ranges.find((x) => l.ts >= x.from && l.ts <= x.to); if (r) m.set(l.ts, r.h); }
    return m;
  }, [lines, highlights]);
  const sceneFlag = highlights.filter((h) => h.kind === "scene" && !h.resolved).at(-1);
  const sceneFlagged = !!(sceneFlag && cap && Math.abs(sceneFlag.ts - cap.ts) < 15_000);
  const speaking = !!interim;
  return (
    <div className="transcript-wrap">
      <section className={`panel caption ${sceneFlagged ? "flagged" : ""}`}>
        <header className="panel-title">
          <span>🎥 Scene</span>{cap && <span className="muted mono">{fmtTime(cap.ts)}</span>}
          <span className="grow" />
          {sceneFlagged && <button className="mark-btn" onClick={() => onOpen(sceneFlag!)}>{sceneFlag!.flags.map((f) => f.label).join(", ")}</button>}
        </header>
        <p className="caption-text">{cap ? cap.text : <span className="muted">waiting for first frame…</span>}</p>
      </section>
      <section className="panel transcript-panel">
        <header className="panel-title">
          <span>🎙 Host</span>
          <span className={`speaking ${speaking ? "on" : ""}`} title={speaking ? "speaking" : "silent"}><i /><i /><i /></span>
          <span className="grow" />
          <span className="live-pill">live</span>
        </header>
        <div className="transcript" ref={ref} onScroll={onScroll} role="log">
          {lines.slice(-80).map((l, i, arr) => {
            const h = marks.get(l.ts);
            const first = h && (i === 0 || marks.get(arr[i - 1].ts) !== h);
            return (
              <div className={`line ${h ? "marked" : ""}`} key={l.ts + "-" + i} onClick={h ? () => onOpen(h) : undefined}>
                <span className="line-time">{fmtTime(l.ts)}</span>
                <span className="line-text">{first && <span className="mark-label">{h!.flags.map((f) => f.label).join(", ")}</span>}{l.text}</span>
              </div>
            );
          })}
          {interim && <div className="line interim"><span className="line-time">…</span><span className="line-text">{interim}<span className="caret" /></span></div>}
          {lines.length === 0 && !interim && <div className="empty">Listening…</div>}
        </div>
        {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>newest ↓</button>}
      </section>
    </div>
  );
}
