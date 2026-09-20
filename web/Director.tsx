import { useEffect, useMemo, useState } from "react";
import type { Highlight, HighlightKind, JevAnswer, WatchQuestion } from "@shared/protocol";
import { api, useSocket } from "./useSocket";
import { ago, hue, initials, pct, useNow, useTween } from "./components/ui";

/** Director prefs live in this browser: the overlay is usually a second screen or an OBS source. */
interface Prefs { ttlSec: number; maxCards: number; hidden: string[]; showMeters: boolean; showChat: boolean; scale: number; transparent: boolean }
const load = (): Prefs => { try { return { ttlSec: 45, maxCards: 4, hidden: [], showMeters: true, showChat: true, scale: 1, transparent: false, ...JSON.parse(localStorage.getItem("jev.director") ?? "{}") }; } catch { return { ttlSec: 45, maxCards: 4, hidden: [], showMeters: true, showChat: true, scale: 1, transparent: false }; } };

const KIND: Record<HighlightKind, { icon: string; verb: string }> = {
  message: { icon: "💬", verb: "Reply to" },
  transcript: { icon: "🎙", verb: "You said" },
  scene: { icon: "🎥", verb: "On camera" },
  room: { icon: "✦", verb: "Room" },
};

const answerText = (a: JevAnswer) => (a.type === "noul" ? pct(a.noul) : a.type === "choice" ? a.choice.replace(/_/g, " ") : (a.legend[String(Math.round(a.score))] ?? "").split(/[:.]/)[0]);

function Meter({ label, answer, q }: { label: string; answer?: JevAnswer; q?: WatchQuestion }) {
  const value = answer ? (answer.type === "noul" ? answer.noul : answer.type === "score" ? answer.score / Math.max(1, Object.keys(answer.legend).length - 1) : answer.confidence) : 0;
  const v = useTween(value);
  const text = answer ? answerText(answer) : "—";
  const fired = !!(answer && q?.alert && ((answer.type === "noul" && q.alert.noulAbove !== undefined && answer.noul >= q.alert.noulAbove) || (answer.type === "choice" && q.alert.choices?.includes(answer.choice)) || (answer.type === "score" && q.alert.scoreAtLeast !== undefined && answer.score >= q.alert.scoreAtLeast)));
  return (
    <div className={`dm ${fired ? "fired" : ""}`}>
      <div className="dm-head"><span>{label}</span><b>{text}</b></div>
      <div className="dm-track"><span style={{ width: `${v * 100}%` }} /></div>
    </div>
  );
}

function Card({ h, onDismiss, onPin, ttlSec, now }: { h: Highlight; onDismiss: () => void; onPin: () => void; ttlSec: number; now: number }) {
  const k = KIND[h.kind];
  const left = h.pinned ? 1 : Math.max(0, 1 - (now - h.ts) / (ttlSec * 1000));
  const primary = h.flags[0];
  const who = h.message ? h.message.nickname || h.message.handle : undefined;
  // A moderation flag is a warning, not an invitation to reply.
  const moderation = h.flags.some((f) => f.answer.type === "choice" && /hostile|spam|scam|toxic|abuse|harass/.test(f.answer.choice));
  const title = h.kind === "message" ? (moderation ? `⚠ Watch ${who}` : `${k.icon} ${k.verb} ${who}`) : h.kind === "transcript" ? "🎙 You said" : h.kind === "scene" ? "🎥 Check the camera" : "✦ Room";
  return (
    <div className={`dc ${h.kind} ${h.pinned ? "pinned" : ""} ${moderation ? "warn" : ""}`} onClick={onDismiss} title="click to dismiss">
      <div className="dc-head">
        <span className="dc-kind">{title}</span>
        <span className="dc-flags">{h.flags.map((f) => <span key={f.questionId} className="dc-flag">{f.label} <i>{answerText(f.answer)}</i></span>)}</span>
        <span className="grow" />
        <span className="dc-ago">{ago(h.ts, now)}</span>
        <button className="dc-pin" onClick={(e) => { e.stopPropagation(); onPin(); }} title={h.pinned ? "unpin" : "keep"}>{h.pinned ? "★" : "☆"}</button>
      </div>
      {h.message && (
        <div className="dc-msg">
          {h.message.avatar ? <img className="dc-avatar" src={h.message.avatar} alt="" referrerPolicy="no-referrer" /> : <span className="dc-avatar" style={{ background: `hsl(${hue(h.message.handle)} 45% 35%)` }}>{initials(who ?? "?")}</span>}
          <p>{h.message.text}</p>
        </div>
      )}
      {h.transcript && <p className="dc-quote">“{h.transcript.lines.map((l) => l.text).join(" ").slice(-220)}”</p>}
      {h.scene && <p className="dc-scene">{h.scene.text}</p>}
      {h.kind === "room" && h.chat && <p className="dc-scene">{h.chat.slice(-3).map((c) => `${c.handle}: ${c.text}`).join(" · ")}</p>}
      {!h.pinned && <span className="dc-ttl" style={{ width: `${left * 100}%` }} />}
      {primary && !h.pinned && left === 0 && <span className="dc-expired" />}
    </div>
  );
}

export function Director() {
  const s = useSocket();
  const now = useNow(1000);
  const [prefs, setPrefs] = useState<Prefs>(load);
  const [panel, setPanel] = useState(false);
  useEffect(() => { try { localStorage.setItem("jev.director", JSON.stringify(prefs)); } catch {} }, [prefs]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("transparent") === "1") setPrefs((p) => ({ ...p, transparent: true }));
    const sc = Number(q.get("scale")); if (sc > 0) setPrefs((p) => ({ ...p, scale: sc }));
  }, []);
  useEffect(() => { document.body.classList.toggle("transparent", prefs.transparent); return () => document.body.classList.remove("transparent"); }, [prefs.transparent]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(false);
      if (e.key === "g") setPanel((v) => !v);
      if (e.key === "x") { const first = cards[0]; if (first) void api.patchHighlight(first.id, { resolved: true }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const allQs = s.questions?.questions ?? [];
  const last = s.decisions.at(-1);
  const hidden = new Set(prefs.hidden);
  const cards = useMemo(() => [...s.highlights]
    .filter((h) => !h.resolved && !h.flags.every((f) => hidden.has(f.questionId)) && (h.pinned || now - h.ts < prefs.ttlSec * 1000))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.ts - a.ts)
    .slice(0, prefs.maxCards), [s.highlights, prefs.hidden, prefs.ttlSec, prefs.maxCards, now]);
  const meters = allQs.filter((q) => q.scope === "window" && !hidden.has(q.id)).slice(0, 5);
  // "waiting" = unanswered chat prompts from the last 10 minutes that are not moderation warnings.
  const waiting = s.highlights.filter((h) => !h.resolved && h.kind === "message" && now - h.ts < 10 * 60_000 && !h.flags.every((f) => hidden.has(f.questionId)) && !h.flags.some((f) => f.answer.type === "choice" && /hostile|spam|scam/.test(f.answer.choice))).length;
  const live = s.status?.state === "live";

  return (
    <div className={`director ${prefs.transparent ? "transparent" : ""}`} style={{ fontSize: `${16 * prefs.scale}px` }}>
      <header className="d-top">
        <span className={`d-live ${live ? "on" : ""}`}><i />{live ? "LIVE" : s.status?.state ?? "offline"}</span>
        {s.snapshot && <span className="d-stat">👁 {s.snapshot.activity.viewers}</span>}
        {s.snapshot && <span className="d-stat cap">💬 {s.snapshot.activity.chat_velocity}</span>}
        {waiting > 0 && <span className="d-stat hot">{waiting} waiting</span>}
        <span className="grow" />
        <button className="d-gear" onClick={() => setPanel((v) => !v)} title="director settings (g)">⚙</button>
      </header>

      {prefs.showMeters && meters.length > 0 && (
        <section className="d-meters">
          {meters.map((q) => <Meter key={q.id} label={q.label} answer={last?.answers[q.id]} q={q} />)}
        </section>
      )}

      <section className="d-cards">
        {cards.map((h) => <Card key={h.id} h={h} now={now} ttlSec={prefs.ttlSec} onDismiss={() => api.patchHighlight(h.id, { resolved: true })} onPin={() => api.patchHighlight(h.id, { pinned: !h.pinned })} />)}
        {cards.length === 0 && <div className="d-idle"><span>all clear</span>{s.snapshot?.scene[0] && prefs.showChat && <small>{s.snapshot.scene.at(-1)}</small>}</div>}
      </section>

      {prefs.showChat && s.chat.length > 0 && (
        <footer className="d-chat">
          {s.chat.slice(-3).map((m) => <span key={m.id} className={s.messageDecisions[m.id]?.fired.length ? "hot" : ""}><b>{m.nickname || m.handle}</b> {m.text}</span>)}
        </footer>
      )}

      {panel && (
        <div className="d-panel" onClick={(e) => e.stopPropagation()}>
          <h3>Director view</h3>
          <label>Card lifetime <input type="range" min={10} max={300} step={5} value={prefs.ttlSec} onChange={(e) => setPrefs({ ...prefs, ttlSec: Number(e.target.value) })} /><b>{prefs.ttlSec}s</b></label>
          <label>Max cards <input type="range" min={1} max={8} step={1} value={prefs.maxCards} onChange={(e) => setPrefs({ ...prefs, maxCards: Number(e.target.value) })} /><b>{prefs.maxCards}</b></label>
          <label>Scale <input type="range" min={0.7} max={2} step={0.1} value={prefs.scale} onChange={(e) => setPrefs({ ...prefs, scale: Number(e.target.value) })} /><b>{prefs.scale.toFixed(1)}×</b></label>
          <label className="row"><input type="checkbox" checked={prefs.showMeters} onChange={(e) => setPrefs({ ...prefs, showMeters: e.target.checked })} /> room meters</label>
          <label className="row"><input type="checkbox" checked={prefs.showChat} onChange={(e) => setPrefs({ ...prefs, showChat: e.target.checked })} /> chat ticker</label>
          <label className="row"><input type="checkbox" checked={prefs.transparent} onChange={(e) => setPrefs({ ...prefs, transparent: e.target.checked })} /> transparent background (OBS)</label>
          <div className="d-qs">
            <span>Show prompts from</span>
            {allQs.map((q) => <label key={q.id} className="row"><input type="checkbox" checked={!hidden.has(q.id)} onChange={(e) => setPrefs({ ...prefs, hidden: e.target.checked ? prefs.hidden.filter((x) => x !== q.id) : [...prefs.hidden, q.id] })} /> {q.label} <small>{q.scope === "message" ? "chat" : "room"}</small></label>)}
          </div>
          <p className="d-help">Click a card to dismiss it · <kbd>x</kbd> dismiss first · <kbd>g</kbd> this panel · OBS: add <code>{location.origin}/?view=director&transparent=1</code> as a browser source.</p>
        </div>
      )}
    </div>
  );
}
