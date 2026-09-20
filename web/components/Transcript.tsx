import { useEffect, useMemo, useRef, useState } from "react";
import type { Highlight } from "@shared/protocol";
import { fmtTime } from "./ui";

export function Transcript({ lines, interim, captions, highlights, onOpen }: { lines: { ts: number; text: string }[]; interim: string; captions: { ts: number; text: string }[]; highlights: Highlight[]; onOpen: (h: Highlight) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => { const el = ref.current; if (el && pinned) el.scrollTop = el.scrollHeight; }, [lines.length, interim, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  const cap = captions.at(-1);
  // Which highlight covers each transcript line (host-speech highlights only).
  const marks = useMemo(() => {
    const ranges = highlights.filter((h) => h.kind === "transcript" && h.transcript && !h.resolved).map((h) => ({ h, from: h.transcript!.from - 500, to: h.transcript!.to + 500 }));
    const m = new Map<number, Highlight>();
    for (const l of lines) { const r = ranges.find((x) => l.ts >= x.from && l.ts <= x.to); if (r) m.set(l.ts, r.h); }
    return m;
  }, [lines, highlights]);
  const sceneFlag = highlights.filter((h) => h.kind === "scene" && !h.resolved).at(-1);
  return (
    <div className="transcript-wrap">
      <div className={`panel caption ${sceneFlag && cap && Math.abs(sceneFlag.ts - cap.ts) < 15_000 ? "flagged" : ""}`}>
        <div className="panel-title">🎥 Scene {cap && <span className="muted">{fmtTime(cap.ts)}</span>}{sceneFlag && cap && Math.abs(sceneFlag.ts - cap.ts) < 15_000 && <button className="mark-btn" onClick={() => onOpen(sceneFlag)}>{sceneFlag.flags.map((f) => f.label).join(", ")}</button>}</div>
        <div className="caption-text">{cap ? cap.text : <span className="muted">waiting for first frame…</span>}</div>
      </div>
      <div className="panel transcript-panel">
        <div className="panel-title">🎙 Host <span className="live-pill">live</span></div>
        <div className="transcript" ref={ref} onScroll={onScroll}>
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
          {interim && <div className="line interim"><span className="line-time">…</span><span className="line-text">{interim}</span></div>}
          {lines.length === 0 && !interim && <div className="empty">Listening…</div>}
        </div>
        {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>↓ newest</button>}
      </div>
    </div>
  );
}
