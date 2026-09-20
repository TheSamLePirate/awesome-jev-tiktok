import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, MessageDecision, WatchQuestion } from "@shared/protocol";
import { Avatar, ago, fmtTime, pct, useNow } from "./ui";
import { usePref } from "../lib/prefs";

function Flags({ d, questions, ageMs }: { d?: MessageDecision; questions: WatchQuestion[]; ageMs: number }) {
  if (!questions.length) return null;
  // A message with no decision after 20 s was skipped (no rules then, or queue drop): do not claim it is being judged.
  if (!d) return ageMs < 20_000 ? <span className="flag pending"><span className="pulse-dot" /> judging</span> : null;
  return (
    <>
      {questions.map((q) => {
        const a = d.answers[q.id];
        if (!a) return d.skipped?.includes(q.id) ? <span key={q.id} className="flag skipped" title="not evaluated (source failed, budget, or rule paused)">{q.label} —</span> : null;
        const fired = d.fired.includes(q.id);
        const text = a.type === "noul" ? `${q.label} ${pct(a.noul)}` : a.type === "choice" ? `${a.choice.replace(/_/g, " ")} ${pct(a.confidence)}` : `${q.label} ${a.score.toFixed(1)}`;
        return <span key={q.id} className={`flag ${fired ? "fired" : ""}`} title={`${q.label} · ${q.local ? "local" : q.question.type}`}>{text}</span>;
      })}
    </>
  );
}

interface Group { user: string; head: ChatEvent; items: ChatEvent[] }

const Row = memo(function Row({ g, decisions, questions, now, onOpenFlag, onUser, muted }: { g: Group; decisions: Record<string, MessageDecision>; questions: WatchQuestion[]; now: number; onOpenFlag: (id: string) => void; onUser: (m: ChatEvent) => void; muted: boolean }) {
  const anyFired = g.items.some((m) => decisions[m.id]?.fired.length);
  return (
    <div className={`msg-group ${anyFired ? "fired" : ""} ${muted ? "muted-user" : ""}`}>
      <Avatar src={g.head.avatar} name={g.head.nickname} handle={g.head.handle} />
      <div className="msg-col">
        <div className="msg-meta">
          <button className="msg-name as-link" onClick={() => onUser(g.head)} title="viewer details">{g.head.nickname || g.head.handle}</button>
          <span className="msg-handle">@{g.head.handle}{g.head.isFollower ? <span className="badge add" title="follows the host"> follows</span> : null}</span>
          <span className="msg-time" title={fmtTime(g.head.ts)}>{ago(g.head.ts, now)}</span>
        </div>
        {g.items.map((m) => {
          const d = decisions[m.id];
          const fired = !!d?.fired.length;
          return (
            <div key={m.id} data-id={m.id} className={`msg ${fired ? "fired" : ""}`}>
              <div className="msg-text">{m.text}</div>
              <div className="flags"><Flags d={d} questions={questions} ageMs={now - m.ts} />{fired && <button className="flag open" onClick={() => onOpenFlag(m.id)}>open ↗</button>}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}, (a, b) => a.g === b.g && a.questions === b.questions && a.now === b.now && a.muted === b.muted && a.g.items.every((m) => a.decisions[m.id] === b.decisions[m.id]));

/** Per-viewer context: their messages in the buffer, flags, and a local mute for their alerts. */
function UserCard({ m, chat, decisions, muted, onMute, onClose }: { m: ChatEvent; chat: ChatEvent[]; decisions: Record<string, MessageDecision>; muted: boolean; onMute: () => void; onClose: () => void }) {
  const mine = chat.filter((c) => c.userId === m.userId);
  const flagged = mine.filter((c) => decisions[c.id]?.fired.length).length;
  return (
    <div className="user-card" role="dialog" aria-label={`viewer ${m.handle}`}>
      <div className="user-head"><Avatar src={m.avatar} name={m.nickname} handle={m.handle} size={28} /><div><b>{m.nickname || m.handle}</b><div className="muted mono">@{m.handle}{m.isFollower ? " · follower" : ""}</div></div><span className="grow" /><button className="icon" onClick={onClose} aria-label="close">✕</button></div>
      <div className="user-stats mono">{mine.length} message{mine.length === 1 ? "" : "s"} in buffer · {flagged} flagged</div>
      <div className="user-msgs">{mine.slice(-8).map((c) => <p key={c.id} className={decisions[c.id]?.fired.length ? "hit" : ""}><span className="q-time">{fmtTime(c.ts)}</span> {c.text}</p>)}</div>
      <div className="row"><button className={`chip-btn ${muted ? "on" : ""}`} onClick={onMute}>{muted ? "🔕 alerts muted in this console" : "🔔 mute this viewer's alerts here"}</button></div>
      <p className="muted small">Muting only hides toasts and chimes in this console. It does not act on TikTok.</p>
    </div>
  );
}

type ChatFilter = "all" | "flagged" | "questions";

export const ChatFeed = memo(function ChatFeed({ chat, decisions, questions, focusId, onOpenFlag }: { chat: ChatEvent[]; decisions: Record<string, MessageDecision>; questions: WatchQuestion[]; focusId: string | null; onOpenFlag: (messageId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [seenCount, setSeenCount] = useState(0);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [q, setQ] = useState("");
  const [user, setUser] = useState<ChatEvent | null>(null);
  const [mutedUsers, setMutedUsers] = usePref<string[]>("jev.mutedUsers", []);
  const now = useNow(5000);
  const decisionCount = useMemo(() => Object.keys(decisions).length, [decisions]);
  useEffect(() => { const el = ref.current; if (el && pinned) { el.scrollTop = el.scrollHeight; setSeenCount(chat.length); } }, [chat.length, decisionCount, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; setPinned(atBottom); if (atBottom) setSeenCount(chat.length); };
  useEffect(() => {
    if (!focusId) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-id="${focusId}"]`);
    if (el) { setPinned(false); el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); }
  }, [focusId]);
  const questionIds = useMemo(() => new Set(questions.filter((qq) => /question|ask/i.test(qq.label) || /question/i.test(String(qq.question.instructions))).map((qq) => qq.id)), [questions]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return chat.filter((m) => {
      if (filter === "flagged" && !decisions[m.id]?.fired.length) return false;
      if (filter === "questions" && !decisions[m.id]?.fired.some((id) => questionIds.has(id))) return false;
      if (needle && !(m.text.toLowerCase().includes(needle) || m.handle.toLowerCase().includes(needle) || m.nickname.toLowerCase().includes(needle))) return false;
      return true;
    }).slice(-160);
  }, [chat, decisions, filter, q, questionIds]);
  // Group consecutive messages from the same user within 90s, so a talkative viewer reads as one block.
  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const m of visible) {
      const last = out.at(-1);
      if (last && last.user === m.userId && m.ts - last.items.at(-1)!.ts < 90_000) last.items.push(m);
      else out.push({ user: m.userId, head: m, items: [m] });
    }
    return out;
  }, [visible]);
  const unread = chat.length - seenCount;
  const onUser = useCallback((m: ChatEvent) => setUser(m), []);
  const mutedSet = useMemo(() => new Set(mutedUsers), [mutedUsers]);
  return (
    <div className="chat-wrap">
      <div className="chat-tools">
        <div className="seg" role="group" aria-label="chat filter">
          {(["all", "flagged", "questions"] as ChatFilter[]).map((f) => <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}
        </div>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter chat…" aria-label="filter chat" />
      </div>
      <div className="chat" ref={ref} onScroll={onScroll} role="log" aria-live="off">
        {groups.map((g) => <Row key={g.head.id} g={g} decisions={decisions} questions={questions} now={now} onOpenFlag={onOpenFlag} onUser={onUser} muted={mutedSet.has(g.head.userId)} />)}
        {chat.length === 0 && <div className="empty">No chat yet.</div>}
        {chat.length > 0 && groups.length === 0 && <div className="empty">No message matches.</div>}
      </div>
      {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>{unread > 0 ? `${unread} new` : "newest"} ↓</button>}
      {user && <UserCard m={user} chat={chat} decisions={decisions} muted={mutedSet.has(user.userId)} onMute={() => setMutedUsers((xs) => (xs.includes(user.userId) ? xs.filter((x) => x !== user.userId) : [...xs, user.userId]))} onClose={() => setUser(null)} />}
    </div>
  );
});
