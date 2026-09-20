import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, MessageDecision, WatchQuestion } from "@shared/protocol";
import { ago, fmtTime, hue, initials, pct, useNow } from "./ui";

function Avatar({ m, size = 34 }: { m: ChatEvent; size?: number }) {
  const [broken, setBroken] = useState(false);
  const name = m.nickname || m.handle;
  if (m.avatar && !broken) return <img className="avatar" style={{ width: size, height: size }} src={m.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />;
  return <span className="avatar" style={{ width: size, height: size, background: `hsl(${hue(m.handle)} 45% 35%)` }}>{initials(name)}</span>;
}

function Flags({ d, questions }: { d?: MessageDecision; questions: WatchQuestion[] }) {
  if (!d) return <span className="flag pending"><span className="pulse-dot" /> judging</span>;
  return (
    <>
      {questions.map((q) => {
        const a = d.answers[q.id];
        if (!a) return null;
        const fired = d.fired.includes(q.id);
        const text = a.type === "noul" ? `${q.label} ${pct(a.noul)}` : a.type === "choice" ? `${a.choice.replace(/_/g, " ")} ${pct(a.confidence)}` : `${q.label} ${a.score.toFixed(1)}`;
        return <span key={q.id} className={`flag ${fired ? "fired" : ""}`} title={`${q.label} · ${q.question.type}`}>{text}</span>;
      })}
    </>
  );
}

interface Group { user: string; head: ChatEvent; items: ChatEvent[] }

const Row = memo(function Row({ g, decisions, questions, now, onOpenFlag }: { g: Group; decisions: Record<string, MessageDecision>; questions: WatchQuestion[]; now: number; onOpenFlag: (id: string) => void }) {
  const anyFired = g.items.some((m) => decisions[m.id]?.fired.length);
  return (
    <div className={`msg-group ${anyFired ? "fired" : ""}`}>
      <Avatar m={g.head} />
      <div className="msg-col">
        <div className="msg-meta">
          <span className="msg-name">{g.head.nickname || g.head.handle}</span>
          <span className="msg-handle">@{g.head.handle}</span>
          <span className="msg-time" title={fmtTime(g.head.ts)}>{ago(g.head.ts, now)}</span>
        </div>
        {g.items.map((m) => {
          const d = decisions[m.id];
          const fired = !!d?.fired.length;
          return (
            <div key={m.id} data-id={m.id} className={`msg ${fired ? "fired" : ""}`} onClick={fired ? () => onOpenFlag(m.id) : undefined} title={fired ? "open in Flagged" : undefined}>
              <div className="msg-text">{m.text}</div>
              <div className="flags"><Flags d={d} questions={questions} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export function ChatFeed({ chat, decisions, questions, focusId, onOpenFlag }: { chat: ChatEvent[]; decisions: Record<string, MessageDecision>; questions: WatchQuestion[]; focusId: string | null; onOpenFlag: (messageId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [seenCount, setSeenCount] = useState(0);
  const now = useNow(5000);
  useEffect(() => { const el = ref.current; if (el && pinned) { el.scrollTop = el.scrollHeight; setSeenCount(chat.length); } }, [chat.length, Object.keys(decisions).length, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; setPinned(atBottom); if (atBottom) setSeenCount(chat.length); };
  useEffect(() => {
    if (!focusId) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-id="${focusId}"]`);
    if (el) { setPinned(false); el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); }
  }, [focusId]);
  // Group consecutive messages from the same user within 90s, so a talkative viewer reads as one block.
  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const m of chat.slice(-160)) {
      const last = out.at(-1);
      if (last && last.user === m.userId && m.ts - last.items.at(-1)!.ts < 90_000) last.items.push(m);
      else out.push({ user: m.userId, head: m, items: [m] });
    }
    return out;
  }, [chat]);
  const unread = chat.length - seenCount;
  return (
    <div className="chat-wrap">
      <div className="chat" ref={ref} onScroll={onScroll} role="log" aria-live="off">
        {groups.map((g) => <Row key={g.head.id} g={g} decisions={decisions} questions={questions} now={now} onOpenFlag={onOpenFlag} />)}
        {chat.length === 0 && <div className="empty">No chat yet.</div>}
      </div>
      {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>{unread > 0 ? `${unread} new` : "newest"} ↓</button>}
    </div>
  );
}
