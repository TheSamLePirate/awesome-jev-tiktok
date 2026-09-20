import { useEffect, useRef, useState } from "react";
import { fmtTime } from "./ui";

export function Transcript({ lines, interim, captions }: { lines: { ts: number; text: string }[]; interim: string; captions: { ts: number; text: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => { const el = ref.current; if (el && pinned) el.scrollTop = el.scrollHeight; }, [lines.length, interim, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  const cap = captions.at(-1);
  return (
    <div className="transcript-wrap">
      <div className="panel caption">
        <div className="panel-title">🎥 Scene {cap && <span className="muted">{fmtTime(cap.ts)}</span>}</div>
        <div className="caption-text">{cap ? cap.text : <span className="muted">waiting for first frame…</span>}</div>
      </div>
      <div className="panel transcript-panel">
        <div className="panel-title">🎙 Host <span className="live-pill">live</span></div>
        <div className="transcript" ref={ref} onScroll={onScroll}>
          {lines.slice(-80).map((l, i) => (
            <div className="line" key={l.ts + "-" + i}>
              <span className="line-time">{fmtTime(l.ts)}</span>
              <span className="line-text">{l.text}</span>
            </div>
          ))}
          {interim && <div className="line interim"><span className="line-time">…</span><span className="line-text">{interim}</span></div>}
          {lines.length === 0 && !interim && <div className="empty">Listening…</div>}
        </div>
        {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>↓ newest</button>}
      </div>
    </div>
  );
}
