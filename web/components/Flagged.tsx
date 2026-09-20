import { useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, HighlightFlag, HighlightKind, JevAnswer, WatchQuestion } from "@shared/protocol";
import { api } from "../useSocket";
import { SourceBadges, fmtTime, hue, initials, pct } from "./ui";

const KIND_META: Record<HighlightKind, { icon: string; label: string }> = {
  message: { icon: "💬", label: "message" },
  transcript: { icon: "🎙", label: "host said" },
  scene: { icon: "🎥", label: "on screen" },
  room: { icon: "✦", label: "room" },
};

export const answerText = (a: JevAnswer) =>
  a.type === "noul" ? pct(a.noul) : a.type === "choice" ? `${a.choice.replace(/_/g, " ")} · ${pct(a.confidence)}` : `${a.legend[String(Math.round(a.score))]?.split(/[:.]/)[0] ?? a.score.toFixed(1)} · ${pct(a.confidence)}`;

function FlagChips({ flags }: { flags: HighlightFlag[] }) {
  return (
    <div className="hl-flags">
      {flags.map((f) => (
        <span key={f.questionId} className="hl-flag" title={`${f.label} (${f.answer.type})`}>
          <b>{f.label}</b> <span className="hl-answer">{answerText(f.answer)}</span>
        </span>
      ))}
    </div>
  );
}

function Card({ h, focused, questions, onJump }: { h: Highlight; focused: boolean; questions: WatchQuestion[]; onJump?: (messageId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [focused]);
  const meta = KIND_META[h.kind];
  const disagree = async () => {
    const f = h.flags[0];
    const q = questions.find((x) => x.id === f.questionId);
    if (!q) return;
    const note = window.prompt(`This "${f.label}" flag is wrong. What should jev have answered, and why?`) ?? undefined;
    setBusy(true);
    await api.feedback({ questionId: f.questionId, answer: f.answer, note, stateExcerpt: { message: h.message ? { handle: h.message.handle, text: h.message.text } : undefined, transcript: h.transcript?.lines.map((l) => l.text).join(" "), scene: h.scene?.text, chat: h.chat } });
    await api.patchHighlight(h.id, { resolved: true });
    setBusy(false);
  };
  const copy = () => {
    const text = h.message ? `${h.message.nickname || h.message.handle}: ${h.message.text}` : h.transcript ? h.transcript.lines.map((l) => l.text).join(" ") : h.scene?.text ?? "";
    void navigator.clipboard.writeText(text);
  };
  return (
    <div ref={ref} className={`hl ${h.kind} ${h.resolved ? "resolved" : ""} ${h.pinned ? "pinned" : ""} ${focused ? "focused" : ""}`}>
      <div className="hl-head">
        <span className="hl-kind" title={meta.label}>{meta.icon} {meta.label}</span>
        <span className="hl-time">{fmtTime(h.ts)}</span>
        <span className="grow" />
        <SourceBadges sources={[...new Set(h.flags.flatMap((f) => f.sources))]} compact />
      </div>
      <FlagChips flags={h.flags} />
      {h.message && (
        <div className="hl-msg">
          {h.message.avatar ? <img className="avatar sm" src={h.message.avatar} alt="" referrerPolicy="no-referrer" /> : <span className="avatar sm" style={{ background: `hsl(${hue(h.message.handle)} 45% 35%)` }}>{initials(h.message.nickname || h.message.handle)}</span>}
          <div className="hl-msg-body">
            <div className="msg-meta"><span className="msg-name">{h.message.nickname || h.message.handle}</span><span className="msg-handle">@{h.message.handle}</span></div>
            <div className="hl-msg-text">{h.message.text}</div>
          </div>
        </div>
      )}
      {h.transcript && (
        <blockquote className="hl-quote">
          {h.transcript.lines.map((l, i) => <span key={l.ts + "-" + i}><span className="q-time">{fmtTime(l.ts)}</span> {l.text} </span>)}
        </blockquote>
      )}
      {h.scene && <div className="hl-scene">🎥 {h.scene.text}</div>}
      {h.chat && h.chat.length > 0 && h.kind !== "message" && (
        <div className="hl-chat">{h.chat.map((c, i) => <div key={i}><span className="msg-name">{c.handle}</span> {c.text}</div>)}</div>
      )}
      {h.activity && h.kind === "room" && <div className="hl-activity">chat {h.activity.chat_velocity} · {h.activity.viewers} viewers ({h.activity.viewers_trend}) · likes {h.activity.likes_last_30s}</div>}
      <div className="hl-actions">
        <button className={`icon ${h.pinned ? "on" : ""}`} title={h.pinned ? "unpin" : "pin"} onClick={() => api.patchHighlight(h.id, { pinned: !h.pinned })}>{h.pinned ? "★" : "☆"}</button>
        <button className={`icon ${h.resolved ? "on" : ""}`} title={h.resolved ? "reopen" : "mark handled"} onClick={() => api.patchHighlight(h.id, { resolved: !h.resolved })}>{h.resolved ? "↺" : "✓"}</button>
        {h.message && onJump && <button className="icon" title="show in chat" onClick={() => onJump(h.message!.id)}>↗</button>}
        <button className="icon" title="copy text" onClick={copy}>⧉</button>
        <span className="grow" />
        <button className="icon" title="wrong flag: GLM rewrites the question" disabled={busy} onClick={disagree}>{busy ? "…" : "👎 wrong"}</button>
        <button className="icon" title="delete" onClick={() => api.removeHighlight(h.id)}>✕</button>
      </div>
    </div>
  );
}

type Filter = "open" | "pinned" | "resolved" | "all";

export function Flagged({ highlights, questions, focusId, onJump }: { highlights: Highlight[]; questions: WatchQuestion[]; focusId: string | null; onJump: (messageId: string) => void }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [kinds, setKinds] = useState<Set<HighlightKind>>(new Set());
  const [qids, setQids] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const toggle = <T,>(set: Set<T>, v: T, setter: (s: Set<T>) => void) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n); };
  const counts = useMemo(() => ({
    open: highlights.filter((h) => !h.resolved).length,
    pinned: highlights.filter((h) => h.pinned).length,
    resolved: highlights.filter((h) => h.resolved).length,
    all: highlights.length,
  }), [highlights]);
  const usedQuestions = useMemo(() => {
    const ids = new Set(highlights.flatMap((h) => h.flags.map((f) => f.questionId)));
    return questions.filter((q) => ids.has(q.id));
  }, [highlights, questions]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...highlights].reverse().filter((h) => {
      if (filter === "open" && h.resolved) return false;
      if (filter === "pinned" && !h.pinned) return false;
      if (filter === "resolved" && !h.resolved) return false;
      if (kinds.size && !kinds.has(h.kind)) return false;
      if (qids.size && !h.flags.some((f) => qids.has(f.questionId))) return false;
      if (q) {
        const hay = [h.message?.text, h.message?.nickname, h.message?.handle, h.transcript?.lines.map((l) => l.text).join(" "), h.scene?.text, ...h.flags.map((f) => f.label)].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [highlights, filter, kinds, qids, search]);

  return (
    <div className="flagged">
      <div className="hl-toolbar">
        <div className="seg">
          {(["open", "pinned", "resolved", "all"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f} <span className="count">{counts[f]}</span></button>
          ))}
        </div>
        <input className="search" placeholder="search flagged…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="hl-filters">
        {(Object.keys(KIND_META) as HighlightKind[]).map((k) => (
          <button key={k} className={`chip-btn ${kinds.has(k) ? "on" : ""}`} onClick={() => toggle(kinds, k, setKinds)}>{KIND_META[k].icon} {KIND_META[k].label}</button>
        ))}
        <span className="sep" />
        {usedQuestions.map((q) => (
          <button key={q.id} className={`chip-btn ${qids.has(q.id) ? "on" : ""}`} onClick={() => toggle(qids, q.id, setQids)}>{q.label}</button>
        ))}
        <span className="grow" />
        {counts.resolved > 0 && <button className="chip-btn" onClick={() => api.clearHighlights("resolved")} title="delete handled items (pinned are kept)">clear handled</button>}
      </div>
      <div className="hl-list">
        {list.map((h) => <Card key={h.id} h={h} focused={h.id === focusId} questions={questions} onJump={onJump} />)}
        {list.length === 0 && <div className="empty">{highlights.length === 0 ? "Nothing flagged yet. When a rule fires, the message, the host's words or the scene lands here." : "No flagged item matches these filters."}</div>}
      </div>
    </div>
  );
}
