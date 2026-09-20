import type { Source } from "@shared/protocol";

export const SOURCE_META: Record<Source, { icon: string; label: string; cls: string }> = {
  transcript: { icon: "🎙", label: "audio", cls: "src-transcript" },
  video: { icon: "🎥", label: "video", cls: "src-video" },
  chat: { icon: "💬", label: "chat", cls: "src-chat" },
};

export function SourceBadges({ sources, compact }: { sources: Source[]; compact?: boolean }) {
  const all = sources.length === 3;
  return (
    <span className="src-badges">
      {all && compact ? <span className="src src-all" title="all media">✦ all</span> : sources.map((s) => <span key={s} className={`src ${SOURCE_META[s].cls}`} title={SOURCE_META[s].label}>{SOURCE_META[s].icon}{compact ? "" : ` ${SOURCE_META[s].label}`}</span>)}
    </span>
  );
}

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const initials = (name: string) => name.trim().slice(0, 2).toUpperCase();
export const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
