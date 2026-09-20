import { useEffect, useRef, useState } from "react";
import type { Source } from "@shared/protocol";

export const SOURCE_META: Record<Source, { icon: string; label: string; cls: string }> = {
  transcript: { icon: "🎙", label: "audio", cls: "src-transcript" },
  video: { icon: "🎥", label: "video", cls: "src-video" },
  chat: { icon: "💬", label: "chat", cls: "src-chat" },
};

export function SourceBadges({ sources, compact }: { sources: Source[]; compact?: boolean }) {
  const all = sources.length === 3;
  return (
    <span className="src-badges" aria-label={`reads ${sources.join(", ")}`}>
      {all && compact ? <span className="src src-all" title="reads audio, video and chat">✦ all</span> : sources.map((s) => <span key={s} className={`src ${SOURCE_META[s].cls}`} title={`reads ${SOURCE_META[s].label}`}>{SOURCE_META[s].icon}{compact ? "" : ` ${SOURCE_META[s].label}`}</span>)}
    </span>
  );
}

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const initials = (name: string) => name.trim().slice(0, 2).toUpperCase();
export const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

/** "just now", "12s", "3m", "1h" — for relative timestamps that tick. */
export const ago = (ts: number, now: number) => {
  const d = Math.max(0, now - ts) / 1000;
  if (d < 5) return "now";
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
};

/** A clock that re-renders every second, for relative times. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}

/** Smoothly tween a number toward its target, so gauges glide instead of jumping. */
export function useTween(target: number, ms = 350) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const start = useRef(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setValue(target); return; }
    from.current = value;
    start.current = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start.current) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setValue(from.current + (target - from.current) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Small ring showing a 0..1 value (confidence). Text stays in text tokens; the arc carries the value. */
export function Ring({ value, size = 22, title }: { value: number; size?: number; title?: string }) {
  const r = (size - 4) / 2, c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title}>
      <title>{title}</title>
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" />
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-value" strokeDasharray={`${c * Math.max(0, Math.min(1, value))} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

export function Spark({ values, max = 1, w = 140, h = 28, className = "" }: { values: number[]; max?: number; w?: number; h?: number; className?: string }) {
  if (values.length < 2) return <svg className={`spark ${className}`} width={w} height={h} aria-hidden />;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - (Math.max(0, Math.min(v, max)) / max) * (h - 4) - 2] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg className={`spark ${className}`} width={w} height={h} aria-hidden>
      <polygon points={`0,${h} ${line} ${w},${h}`} className="spark-area" />
      <polyline points={line} fill="none" className="spark-line" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" className="spark-dot" />
    </svg>
  );
}

export function Kbd({ k }: { k: string }) { return <kbd className="kbd">{k}</kbd>; }
