import { useEffect } from "react";
import type { Highlight } from "@shared/protocol";
import { answerText } from "./Flagged";

export function Toasts({ toasts, onDismiss, onOpen, durationMs }: { toasts: Highlight[]; onDismiss: (id: string) => void; onOpen: (h: Highlight) => void; durationMs: number }) {
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => onDismiss(toasts[0].id), durationMs);
    return () => clearTimeout(t);
  }, [toasts, onDismiss, durationMs]);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((h) => (
        <div key={h.id} className={`toast ${h.kind}`} onClick={() => onOpen(h)} role="status">
          <div className="toast-head">{h.flags.map((f) => `${f.label} ${answerText(f.answer)}`).join(" · ")}</div>
          <div className="toast-body">{h.message ? `${h.message.nickname || h.message.handle}: ${h.message.text}` : h.transcript ? h.transcript.lines.map((l) => l.text).join(" ").slice(-140) : h.scene?.text ?? "room activity"}</div>
          <button className="icon" onClick={(e) => { e.stopPropagation(); onDismiss(h.id); }} aria-label="dismiss">✕</button>
          <span className="toast-bar" style={{ animationDuration: `${durationMs}ms` }} />
        </div>
      ))}
    </div>
  );
}

/** A soft two-tone chime, generated locally so there is no asset to load. */
export function chime() {
  try {
    const ctx = new AudioContext();
    const play = (f: number, t: number) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = "sine"; o.frequency.value = f; g.gain.value = 0.0001; o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35); o.stop(ctx.currentTime + t + 0.4); };
    play(880, 0); play(1174, 0.12);
  } catch {}
}
