import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, HighlightFlag, HighlightKind, WatchQuestion } from "@shared/protocol";
import { api } from "../lib/api";
import { answerText } from "../lib/format";
import { toast } from "../lib/store";
import { confirm, prompt } from "./Dialog";
import { Avatar, SourceBadges, ago, fmtTime, useNow } from "./ui";

const KIND_META: Record<HighlightKind, { icon: string; label: string }> = {
  message: { icon: "💬", label: "message" },
  transcript: { icon: "🎙", label: "host said" },
  scene: { icon: "🎥", label: "on screen" },
  room: { icon: "✦", label: "room" },
};

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

/** Delete with a 60 s undo (the server keeps the item in a trash). */
export const removeWithUndo = async (h: Highlight) => {
  try {
    const r = await api.removeHighlight(h.id);
    toast({ kind: "undo", title: "Flag deleted", body: h.flags.map((f) => f.label).join(", "), durationMs: Math.min(r.undoMs, 15_000), action: { label: "Undo", run: () => void api.restoreHighlight(h.id).catch(() => {}) } });
  } catch { /* toasted */ }
};

const Card = memo(function Card({ h, focused, questions, onJump, onWatch, now, showEvidence }: { h: Highlight; focused: boolean; questions: WatchQuestion[]; onJump?: (messageId: string) => void; onWatch?: (ts: number) => void; now: number; showEvidence: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [focused]);
  const meta = KIND_META[h.kind];
  const feedback = useCallback(async () => {
    const choices = h.flags.map((f) => ({ value: f.questionId, label: `${f.label} · ${answerText(f.answer)}` }));
    const r = await prompt({ title: "Rate this flag", body: "Cancel sends nothing. A verdict is recorded; 'wrong' and 'missed' also let GLM rewrite the question with your note.", placeholder: "What should jev have answered, and why?", confirmLabel: "Send", choices: [...choices.map((c) => ({ value: `wrong:${c.value}`, label: `Wrong: ${c.label}` })), ...choices.map((c) => ({ value: `correct:${c.value}`, label: `Correct: ${c.label}` }))], choiceLabel: "Verdict" });
    if (!r || !r.choice) return;
    const [verdict, questionId] = r.choice.split(":") as ["wrong" | "correct", string];
    const f = h.flags.find((x) => x.questionId === questionId);
    const q = questions.find((x) => x.id === questionId);
    if (!f || !q) return;
    setBusy(true);
    try {
      const res = await api.feedback({ questionId, verdict, answer: f.answer, note: r.text || undefined, expected: r.text || undefined, highlightId: h.id, stateExcerpt: h.evidence ?? { message: h.message ? { handle: h.message.handle, text: h.message.text } : undefined, transcript: h.transcript?.lines.map((l) => l.text).join(" "), scene: h.scene?.text, chat: h.chat } });
      toast({ kind: "info", title: res.rewritten ? `GLM rewrote "${q.label}"` : "Feedback recorded" });
    } catch { /* toasted */ }
    finally { setBusy(false); }
  }, [h, questions]);
  const copy = () => {
    const text = h.message ? `${h.message.nickname || h.message.handle}: ${h.message.text}` : h.transcript ? h.transcript.lines.map((l) => l.text).join(" ") : h.scene?.text ?? "";
    void navigator.clipboard?.writeText(text);
  };
  return (
    <div ref={ref} className={`hl ${h.kind} ${h.resolved ? "resolved" : ""} ${h.pinned ? "pinned" : ""} ${focused ? "focused" : ""} ${h.severity === "warn" ? "warn" : ""}`}>
      {/* One head row: what and when on the left, every action on the right (no separate action bar). */}
      <div className="hl-head">
        <span className="hl-kind" title={meta.label}>{h.severity === "warn" ? "⚠ " : `${meta.icon} `}{meta.label}</span>
        <span className="hl-time" title={fmtTime(h.ts)}>{ago(h.ts, now)}</span>
        {h.version !== undefined && <span className="muted mono" title="question set version">v{h.version}</span>}
        <SourceBadges sources={[...new Set(h.flags.flatMap((f) => f.sources))]} compact />
        <div className="hl-actions">
          <button className={`icon ${h.pinned ? "on" : ""}`} title={h.pinned ? "unpin" : "pin"} aria-label={h.pinned ? "unpin" : "pin"} aria-pressed={h.pinned} onClick={() => api.patchHighlight(h.id, { pinned: !h.pinned }).catch(() => {})}>{h.pinned ? "★" : "☆"}</button>
          <button className={`icon ${h.resolved ? "on" : ""}`} title={h.resolved ? "reopen" : "mark handled"} aria-label={h.resolved ? "reopen" : "mark handled"} onClick={() => api.patchHighlight(h.id, { resolved: !h.resolved }).catch(() => {})}>{h.resolved ? "↺" : "✓"}</button>
          {onWatch && <button className="icon" title="watch this moment" aria-label="watch this moment" onClick={() => onWatch(h.ts)}>⏪</button>}
          {h.message && onJump && <button className="icon" title="show in chat" aria-label="show in chat" onClick={() => onJump(h.message!.id)}>↗</button>}
          <button className="icon" title="copy text" aria-label="copy text" onClick={copy}>⧉</button>
          {h.evidence !== undefined && <button className={`icon ${why ? "on" : ""}`} title="why did this fire: the exact state jev judged" aria-label="why did this fire" onClick={() => setWhy((v) => !v)}>?</button>}
          <button className="icon" title="rate this flag (correct / wrong)" aria-label="rate this flag" disabled={busy} onClick={feedback}>{busy ? "…" : "👎"}</button>
          <button className="icon danger" title="delete (undo for 60 s)" aria-label="delete" onClick={() => void removeWithUndo(h)}>✕</button>
        </div>
      </div>
      <FlagChips flags={h.flags} />
      {h.message && (
        <div className="hl-msg">
          <Avatar src={h.message.avatar} name={h.message.nickname} handle={h.message.handle} size={28} className="sm" />
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
      {showEvidence && why && h.evidence !== undefined && <pre className="hl-evidence" aria-label="what jev saw">{JSON.stringify(h.evidence, null, 1)}</pre>}
    </div>
  );
});

type Filter = "open" | "pinned" | "resolved" | "all";

export const Flagged = memo(function Flagged({ highlights, questions, focusId, onJump, onWatch, canWatch }: { highlights: Highlight[]; questions: WatchQuestion[]; focusId: string | null; onJump: (messageId: string) => void; onWatch: (ts: number) => void; canWatch: boolean }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [kinds, setKinds] = useState<Set<HighlightKind>>(new Set());
  const [qids, setQids] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const now = useNow(5000);

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
    }).slice(0, 200);
  }, [highlights, filter, kinds, qids, search]);

  const clearHandled = async () => {
    if (!(await confirm({ title: `Clear ${counts.resolved} handled flag${counts.resolved > 1 ? "s" : ""}?`, body: "Pinned items are kept. You can undo for 60 seconds.", confirmLabel: "Clear", danger: true }))) return;
    try {
      const r = await api.clearHighlights("resolved");
      toast({ kind: "undo", title: `${r.removed.length} flags cleared`, durationMs: 15_000, action: { label: "Undo", run: () => { for (const id of r.removed) void api.restoreHighlight(id).catch(() => {}); } } });
    } catch { /* toasted */ }
  };

  return (
    <div className="flagged">
      <div className="hl-toolbar">
        <div className="seg" role="group" aria-label="flag state filter">
          {(["open", "pinned", "resolved", "all"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f} <span className="count">{counts[f]}</span></button>
          ))}
        </div>
        <input id="hl-search" name="flagged-search" className="search" placeholder="search flagged…  /" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="search flagged" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" />
      </div>
      <div className="hl-filters">
        {(Object.keys(KIND_META) as HighlightKind[]).map((k) => (
          <button key={k} className={`chip-btn ${kinds.has(k) ? "on" : ""}`} aria-pressed={kinds.has(k)} onClick={() => toggle(kinds, k, setKinds)}>{KIND_META[k].icon} {KIND_META[k].label}</button>
        ))}
        <span className="sep" />
        {usedQuestions.map((q) => (
          <button key={q.id} className={`chip-btn ${qids.has(q.id) ? "on" : ""}`} aria-pressed={qids.has(q.id)} onClick={() => toggle(qids, q.id, setQids)}>{q.label}</button>
        ))}
        <span className="grow" />
        {counts.resolved > 0 && <button className="chip-btn" onClick={clearHandled} title="delete handled items (pinned are kept, undo for 60 s)">clear handled</button>}
      </div>
      <div className="hl-list">
        {list.map((h) => <Card key={h.id} h={h} focused={h.id === focusId} questions={questions} onJump={onJump} onWatch={canWatch ? onWatch : undefined} now={now} showEvidence />)}
        {list.length === 0 && <div className="empty">{highlights.length === 0 ? "Nothing flagged yet. When a rule fires, the message, the host's words or the scene lands here." : "No flagged item matches these filters."}</div>}
      </div>
    </div>
  );
});
