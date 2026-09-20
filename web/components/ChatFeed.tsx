import { useEffect, useRef, useState } from "react";
import type { ChatEvent, MessageDecision, WatchQuestion } from "@shared/protocol";
import { fmtTime, hue, initials, pct } from "./ui";

function Avatar({ m }: { m: ChatEvent }) {
  const [broken, setBroken] = useState(false);
  const name = m.nickname || m.handle;
  if (m.avatar && !broken) return <img className="avatar" src={m.avatar} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />;
  return <span className="avatar" style={{ background: `hsl(${hue(m.handle)} 45% 35%)` }}>{initials(name)}</span>;
}

function Flags({ d, questions }: { d?: MessageDecision; questions: WatchQuestion[] }) {
  if (!d) return <span className="flag pending">judging…</span>;
  return (
    <>
      {questions.map((q) => {
        const a = d.answers[q.id];
        if (!a) return null;
        const fired = d.fired.includes(q.id);
        const text = a.type === "noul" ? `${q.label} ${pct(a.noul)}` : a.type === "choice" ? `${a.choice.replace(/_/g, " ")} ${pct(a.confidence)}` : `${q.label} ${a.score.toFixed(1)}`;
        return <span key={q.id} className={`flag ${fired ? "fired" : ""}`} title={`${q.label} (${q.question.type})`}>{text}</span>;
      })}
    </>
  );
}

export function ChatFeed({ chat, decisions, questions }: { chat: ChatEvent[]; decisions: Record<string, MessageDecision>; questions: WatchQuestion[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => { const el = ref.current; if (el && pinned) el.scrollTop = el.scrollHeight; }, [chat.length, Object.keys(decisions).length, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  return (
    <div className="chat-wrap">
      <div className="chat" ref={ref} onScroll={onScroll}>
        {chat.slice(-150).map((m) => {
          const d = decisions[m.id];
          return (
            <div key={m.id} className={`msg ${d?.fired.length ? "fired" : ""}`}>
              <Avatar m={m} />
              <div className="msg-body">
                <div className="msg-meta">
                  <span className="msg-name">{m.nickname || m.handle}</span>
                  <span className="msg-handle">@{m.handle}</span>
                  <span className="msg-time">{fmtTime(m.ts)}</span>
                </div>
                <div className="msg-text">{m.text}</div>
                <div className="flags"><Flags d={d} questions={questions} /></div>
              </div>
            </div>
          );
        })}
        {chat.length === 0 && <div className="empty">No chat yet.</div>}
      </div>
      {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>↓ newest</button>}
    </div>
  );
}
