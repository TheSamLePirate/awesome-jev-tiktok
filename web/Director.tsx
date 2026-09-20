import { memo, useEffect, useMemo, useState } from "react";
import type { Highlight, HighlightKind, JevAnswer, WatchQuestion } from "@shared/protocol";
import { api } from "./lib/api";
import { answerShort } from "./lib/format";
import { usePref } from "./lib/prefs";
import { useHotkeys } from "./lib/hotkeys";
import { getState, useStore } from "./lib/store";
import { Avatar, ago, useNow, useTween } from "./components/ui";
import { DialogHost } from "./components/Dialog";

/** Director prefs live in this browser: the overlay is usually a second screen or an OBS source. */
interface Prefs { ttlSec: number; maxCards: number; hidden: string[]; showMeters: boolean; showChat: boolean; scale: number; transparent: boolean; showWarnings: boolean }
const DEFAULTS: Prefs = { ttlSec: 45, maxCards: 4, hidden: [], showMeters: true, showChat: true, scale: 1, transparent: false, showWarnings: true };

const KIND: Record<HighlightKind, { icon: string; verb: string }> = {
  message: { icon: "💬", verb: "Reply to" },
  transcript: { icon: "🎙", verb: "You said" },
  scene: { icon: "🎥", verb: "On camera" },
  room: { icon: "✦", verb: "Room" },
};

const Meter = memo(function Meter({ label, answer, fired, skipped }: { label: string; answer?: JevAnswer; fired: boolean; skipped: boolean }) {
  const value = answer ? (answer.type === "noul" ? answer.noul : answer.type === "score" ? answer.score / Math.max(1, Object.keys(answer.legend).length - 1) : answer.confidence) : 0;
  const v = useTween(value);
  const text = skipped ? "n/a" : answer ? answerShort(answer) : "—";
  return (
    <div className={`dm ${fired ? "fired" : ""} ${skipped ? "skipped" : ""}`}>
      <div className="dm-head"><span>{label}</span><b>{text}</b></div>
      <div className="dm-track"><span style={{ width: `${v * 100}%` }} /></div>
    </div>
  );
});

const Card = memo(function Card({ h, onDismiss, onPin, ttlSec, now }: { h: Highlight; onDismiss: () => void; onPin: () => void; ttlSec: number; now: number }) {
  const k = KIND[h.kind];
  const left = h.pinned ? 1 : Math.max(0, 1 - (now - h.ts) / (ttlSec * 1000));
  const who = h.message ? h.message.nickname || h.message.handle : undefined;
  // The server tags moderation-like flags: a warning, not an invitation to reply.
  const warn = h.severity === "warn";
  const title = h.kind === "message" ? (warn ? `⚠ Watch ${who}` : `${k.icon} ${k.verb} ${who}`) : h.kind === "transcript" ? "🎙 You said" : h.kind === "scene" ? "🎥 Check the camera" : "✦ Room";
  return (
    <div className={`dc ${h.kind} ${h.pinned ? "pinned" : ""} ${warn ? "warn" : ""}`} role="group" aria-label={title}>
      <div className="dc-head">
        <span className="dc-kind">{title}</span>
        <span className="dc-flags">{h.flags.map((f) => <span key={f.questionId} className="dc-flag">{f.label} <i>{answerShort(f.answer)}</i></span>)}</span>
        <span className="grow" />
        <span className="dc-ago">{ago(h.ts, now)}</span>
        <button className="dc-pin" onClick={onPin} title={h.pinned ? "unpin" : "keep"} aria-label={h.pinned ? "unpin" : "keep"} aria-pressed={h.pinned}>{h.pinned ? "★" : "☆"}</button>
        <button className="dc-pin" onClick={onDismiss} title="dismiss" aria-label="dismiss">✕</button>
      </div>
      {h.message && (
        <div className="dc-msg">
          <Avatar src={h.message.avatar} name={who ?? "?"} handle={h.message.handle} className="dc-avatar" />
          <p>{h.message.text}</p>
        </div>
      )}
      {h.transcript && <p className="dc-quote">“{h.transcript.lines.map((l) => l.text).join(" ").slice(-220)}”</p>}
      {h.scene && <p className="dc-scene">{h.scene.text}</p>}
      {h.kind === "room" && h.chat && <p className="dc-scene">{h.chat.slice(-3).map((c) => `${c.handle}: ${c.text}`).join(" · ")}</p>}
      {!h.pinned && <span className="dc-ttl" style={{ width: `${left * 100}%` }} />}
    </div>
  );
});

export function Director() {
  const now = useNow(1000);
  // Persisted prefs, plus a non-persisted override layer from the URL (?transparent=1&scale=1.2 for OBS).
  const [saved, setSaved] = usePref<Prefs>("jev.director", DEFAULTS);
  const overrides = useMemo(() => { const q = new URLSearchParams(location.search); const o: Partial<Prefs> = {}; if (q.get("transparent") === "1") o.transparent = true; const sc = Number(q.get("scale")); if (sc > 0) o.scale = sc; if (q.get("warnings") === "0") o.showWarnings = false; return o; }, []);
  const prefs: Prefs = { ...DEFAULTS, ...saved, ...overrides };
  const setPrefs = (p: Partial<Prefs>) => setSaved((s) => ({ ...DEFAULTS, ...s, ...p }));
  const [panel, setPanel] = useState(false);
  useEffect(() => { document.body.classList.toggle("transparent", prefs.transparent); return () => document.body.classList.remove("transparent"); }, [prefs.transparent]);

  const status = useStore((s) => s.status);
  const connected = useStore((s) => s.connected);
  const highlights = useStore((s) => s.highlights);
  const windowQs = useStore((s) => s.windowQs);
  const allQs = useStore((s) => s.questions?.questions ?? []);
  const last = useStore((s) => s.decisions.at(-1));
  const snapshot = useStore((s) => s.snapshot);
  const health = useStore((s) => s.health);
  const chat3 = useStore((s) => s.chat.slice(-3).map((m) => `${m.id}${m.nickname || m.handle}${m.text}${s.messageDecisions[m.id]?.fired.length ? 1 : 0}`).join(""));
  const chat = useMemo(() => chat3 ? chat3.split("").map((row) => { const [id, name, text, hot] = row.split(""); return { id, name, text, hot: hot === "1" }; }) : [], [chat3]);

  const hidden = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const cards = useMemo(() => [...highlights]
    .filter((h) => !h.resolved && !h.flags.every((f) => hidden.has(f.questionId)) && (prefs.showWarnings || h.severity !== "warn") && (h.pinned || now - h.ts < prefs.ttlSec * 1000))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.ts - a.ts)
    .slice(0, prefs.maxCards), [highlights, hidden, prefs.ttlSec, prefs.maxCards, prefs.showWarnings, now]);
  const meters = useMemo(() => windowQs.filter((q) => !hidden.has(q.id)).slice(0, 5), [windowQs, hidden]);
  // "waiting" = unanswered chat prompts from the last 10 minutes that are not warnings.
  const waiting = useMemo(() => highlights.filter((h) => !h.resolved && h.kind === "message" && now - h.ts < 10 * 60_000 && !h.flags.every((f) => hidden.has(f.questionId)) && h.severity !== "warn").length, [highlights, hidden, now]);

  // Honest state: LIVE only when the server socket is up AND the stream is live; otherwise say what is wrong.
  const live = connected && status?.state === "live";
  const decisionAge = last ? Math.round((now - last.ts) / 1000) : null;
  const stale = live && (decisionAge === null || decisionAge > 10);
  const sourcesDown = snapshot ? (Object.entries(snapshot.sources) as [string, { state: string }][]).filter(([, h]) => h.state === "error" || h.state === "missing").map(([k]) => k) : [];
  const paused = !!(health?.breaker && health.breaker.until > now) || !!health?.budget.stopped;
  const stateLabel = !connected ? "console offline" : status?.state !== "live" ? status?.state ?? "offline" : paused ? "paid calls paused" : stale ? "no decision" : "LIVE";

  useHotkeys(useMemo(() => [
    { key: "Escape", label: "esc", help: "close panel", global: true, run: () => setPanel(false) },
    { key: "g", label: "g", help: "settings panel", run: () => setPanel((v) => !v) },
    { key: "x", label: "x", help: "dismiss the first card", run: () => { const first = cards[0]; if (first) void api.patchHighlight(first.id, { resolved: true }).catch(() => {}); } },
  ], [cards]));

  return (
    <div className={`director ${prefs.transparent ? "transparent" : ""}`} style={{ fontSize: `${16 * prefs.scale}px` }}>
      <header className="d-top">
        <span className={`d-live ${live && !stale && !paused ? "on" : ""} ${paused || stale ? "warn" : ""}`}><i />{stateLabel}</span>
        {snapshot && <span className="d-stat">👁 {snapshot.activity.viewers}</span>}
        {snapshot && <span className="d-stat cap">💬 {snapshot.activity.chat_velocity}</span>}
        {waiting > 0 && <span className="d-stat hot">{waiting} waiting</span>}
        {sourcesDown.length > 0 && <span className="d-stat warn" title={sourcesDown.join(", ")}>{sourcesDown.map((s) => (s === "transcript" ? "🎙" : s === "video" ? "🎥" : "💬")).join(" ")} unavailable</span>}
        <span className="grow" />
        <button className="d-gear" onClick={() => setPanel((v) => !v)} title="director settings (g)" aria-label="director settings">⚙</button>
      </header>

      {prefs.showMeters && meters.length > 0 && (
        <section className="d-meters" aria-label="room meters">
          {meters.map((q) => <Meter key={q.id} label={q.label} answer={last?.answers[q.id]} fired={last?.fired.includes(q.id) ?? false} skipped={last?.skipped?.includes(q.id) ?? false} />)}
        </section>
      )}

      <section className="d-cards" aria-live="polite">
        {cards.map((h) => <Card key={h.id} h={h} now={now} ttlSec={prefs.ttlSec} onDismiss={() => void api.patchHighlight(h.id, { resolved: true }).catch(() => {})} onPin={() => void api.patchHighlight(h.id, { pinned: !h.pinned }).catch(() => {})} />)}
        {cards.length === 0 && (
          <div className="d-idle">
            <span>{!live ? stateLabel : paused ? "decisions paused" : stale ? "waiting for decisions" : "nothing to act on"}</span>
            <small>{live && last ? `last decision ${decisionAge} s ago${sourcesDown.length ? ` · ${sourcesDown.join(", ")} unavailable` : ""}` : status?.detail ?? ""}</small>
          </div>
        )}
      </section>

      {prefs.showChat && chat.length > 0 && (
        <footer className="d-chat" aria-label="latest chat">
          {chat.map((m) => <span key={m.id} className={m.hot ? "hot" : ""}><b>{m.name}</b> {m.text}</span>)}
        </footer>
      )}

      {panel && (
        <div className="d-panel" role="dialog" aria-label="director settings">
          <h3>Director view</h3>
          <label>Card lifetime <input type="range" min={10} max={300} step={5} value={prefs.ttlSec} onChange={(e) => setPrefs({ ttlSec: Number(e.target.value) })} /><b>{prefs.ttlSec}s</b></label>
          <label>Max cards <input type="range" min={1} max={8} step={1} value={prefs.maxCards} onChange={(e) => setPrefs({ maxCards: Number(e.target.value) })} /><b>{prefs.maxCards}</b></label>
          <label>Scale <input type="range" min={0.7} max={2} step={0.1} value={prefs.scale} onChange={(e) => setPrefs({ scale: Number(e.target.value) })} /><b>{prefs.scale.toFixed(1)}×</b></label>
          <label className="row"><input type="checkbox" checked={prefs.showMeters} onChange={(e) => setPrefs({ showMeters: e.target.checked })} /> room meters</label>
          <label className="row"><input type="checkbox" checked={prefs.showChat} onChange={(e) => setPrefs({ showChat: e.target.checked })} /> chat ticker</label>
          <label className="row"><input type="checkbox" checked={prefs.showWarnings} onChange={(e) => setPrefs({ showWarnings: e.target.checked })} /> moderation warnings <small>(off for a public overlay)</small></label>
          <label className="row"><input type="checkbox" checked={prefs.transparent} onChange={(e) => setPrefs({ transparent: e.target.checked })} /> transparent background (OBS)</label>
          <div className="d-qs">
            <span>Show prompts from</span>
            {allQs.map((q: WatchQuestion) => <label key={q.id} className="row"><input type="checkbox" checked={!hidden.has(q.id)} onChange={(e) => setPrefs({ hidden: e.target.checked ? prefs.hidden.filter((x) => x !== q.id) : [...prefs.hidden, q.id] })} /> {q.label} <small>{q.scope === "message" ? "chat" : "room"}</small></label>)}
          </div>
          <p className="d-help">✕ dismisses a card · <kbd>x</kbd> dismiss first · <kbd>g</kbd> this panel · OBS: add <code>{location.origin}/?view=director&transparent=1&warnings=0</code> as a browser source (URL options apply to that source only and are not saved here). A public overlay should not show moderation warnings or private notes.</p>
        </div>
      )}
      <DialogHost />
    </div>
  );
}

// The director never opens the video player; keep the store import side-effect free.
void getState;
