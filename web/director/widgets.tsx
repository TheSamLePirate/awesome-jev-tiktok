import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { Highlight, JevAnswer } from "@shared/protocol";
import { answerShort } from "../lib/format";
import { Avatar, Spark, ago, useTween } from "../components/ui";
import { TIMING, cardBody, cardTitle, fmtCountdown, meterText, meterValue, type NoteItem, type RuleRow } from "./model";

/** Keeps an item rendered for a moment after it leaves the list, so it can animate out. */
export function usePresence<T>(items: T[], key: (t: T) => string): { item: T; leaving: boolean }[] {
  const [gone, setGone] = useState<{ item: T; key: string }[]>([]);
  const prev = useRef<T[]>([]);
  useEffect(() => {
    const keys = new Set(items.map(key));
    const left = prev.current.filter((t) => !keys.has(key(t)));
    prev.current = items;
    if (!left.length) return;
    const leftKeys = left.map(key);
    setGone((g) => [...g.filter((x) => !keys.has(x.key) && !leftKeys.includes(x.key)), ...left.map((item) => ({ item, key: key(item) }))]);
    setTimeout(() => setGone((g) => g.filter((x) => !leftKeys.includes(x.key))), TIMING.leaveMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const live = new Set(items.map(key));
  return [...items.map((item) => ({ item, leaving: false })), ...gone.filter((g) => !live.has(g.key)).map((g) => ({ item: g.item, leaving: true }))];
}

export interface CardActions { onDone: (h: Highlight) => void; onPin: (h: Highlight) => void; onSnooze: (h: Highlight) => void; onSelect: (h: Highlight) => void }

/** One prompt. `size` big = teleprompter, small = queue preview. */
export const Card = memo(function Card({ h, now, ttlSec, selected, leaving, size, actions }: { h: Highlight; now: number; ttlSec: number; selected?: boolean; leaving?: boolean; size?: "big" | "small"; actions: CardActions }) {
  const left = h.pinned ? 1 : Math.max(0, 1 - (now - h.ts) / (ttlSec * 1000));
  const warn = h.severity === "warn";
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <article className={`dc ${h.kind} ${h.pinned ? "pinned" : ""} ${warn ? "warn" : ""} ${selected ? "selected" : ""} ${leaving ? "leaving" : ""} ${size ?? ""}`} role="group" aria-label={cardTitle(h)} aria-current={selected ? "true" : undefined} onClick={() => actions.onSelect(h)}>
      <header className="dc-head">
        <span className="dc-kind">{cardTitle(h)}</span>
        <span className="dc-flags">{h.flags.map((f) => <span key={f.questionId} className="dc-flag">{f.label} <i>{answerShort(f.answer)}</i></span>)}</span>
        <span className="grow" />
        <span className="dc-ago">{ago(h.ts, now)}</span>
        {size !== "small" && (
          <span className="dc-actions">
            <button className="dc-btn" onClick={(e) => { e.stopPropagation(); actions.onPin(h); }} title={h.pinned ? "unfeature (f)" : "feature: keep it and show it in the overlay (f)"} aria-label={h.pinned ? "unfeature" : "feature"} aria-pressed={h.pinned}>{h.pinned ? "★" : "☆"}</button>
            <button className="dc-btn" onClick={(e) => { e.stopPropagation(); actions.onSnooze(h); }} title="snooze: bring it back in a few minutes (z)" aria-label="snooze">zz</button>
            <button className="dc-btn ok" onClick={(e) => { e.stopPropagation(); actions.onDone(h); }} title="done (↵)" aria-label="done">✓</button>
          </span>
        )}
      </header>
      {h.message ? (
        <div className="dc-msg">
          <Avatar src={h.message.avatar} name={h.message.nickname || h.message.handle} handle={h.message.handle} className="dc-avatar" />
          <p>{h.message.text}</p>
        </div>
      ) : <p className={h.transcript ? "dc-quote" : "dc-scene"}>{cardBody(h)}</p>}
      {!h.pinned && <span className="dc-ttl" style={{ width: `${left * 100}%` }} />}
    </article>
  );
});

export const Meter = memo(function Meter({ label, answer, fired, skipped, history }: { label: string; answer?: JevAnswer; fired: boolean; skipped: boolean; history?: number[] }) {
  const v = useTween(meterValue(answer));
  return (
    <div className={`dm ${fired ? "fired" : ""} ${skipped ? "skipped" : ""}`} role="meter" aria-label={label} aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="dm-head"><span>{label}</span><b>{meterText(answer, skipped)}</b></div>
      <div className="dm-track"><span style={{ width: `${v * 100}%` }} /></div>
      {history && history.length > 1 && <Spark values={history} h={18} stretch className="dm-spark" />}
    </div>
  );
});

/** One rule on the dashboard: what it says now, how often it fired this session, and the latest thing it flagged. */
export const RuleCard = memo(function RuleCard({ r, now }: { r: RuleRow; now: number }) {
  const room = r.scope === "window";
  const v = useTween(room ? meterValue(r.answer) : r.judged ? r.matched / r.judged : 0);
  const who = r.last?.message ? r.last.message.nickname || r.last.message.handle : "";
  return (
    <article className={`d-rule ${r.scope} ${r.fired ? "fired" : ""} ${r.paused ? "paused" : ""} ${r.skipped ? "skipped" : ""} ${r.muted ? "muted" : ""}`} aria-label={r.label}>
      <header className="d-rule-head">
        <span className="d-rule-scope" aria-hidden title={room ? "room rule: judged every tick" : "chat rule: judged per message"}>{room ? "✦" : "💬"}</span>
        <span className="d-rule-label" title={r.sources.join(" + ")}>{r.label}</span>
        {r.local && <span className="d-rule-tag" title="keyword / regex, evaluated locally">⌘</span>}
        {r.paused && <span className="d-rule-tag warn">paused</span>}
        {r.muted && <span className="d-rule-tag" title="hidden from the prompt queue (settings)">muted</span>}
        <span className="grow" />
        <b className="d-rule-now">{room ? meterText(r.answer, r.skipped) : r.judged ? `${r.matched} / ${r.judged}` : "—"}</b>
      </header>
      <div className="dm-track"><span style={{ width: `${v * 100}%` }} /></div>
      {r.history.length > 1 && <Spark values={r.history} h={18} stretch className="dm-spark" />}
      <footer className="d-rule-foot">
        <span>{r.fires ? `fired ×${r.fires}` : "not fired yet"}</span>
        {r.lastFire !== null && <span>· {ago(r.lastFire, now)}</span>}
        {!room && <span>· {r.judged} judged</span>}
      </footer>
      {r.last && (
        <div className="d-rule-last" title={cardBody(r.last)}>
          {r.last.message && <Avatar src={r.last.message.avatar} name={who} handle={r.last.message.handle} size={22} className="d-rule-avatar" />}
          <span>{r.last.message ? <><b>{who}</b> {r.last.message.text}</> : cardBody(r.last)}</span>
        </div>
      )}
    </article>
  );
});

/** A number the host can read from a distance, with an optional trend and sparkline. */
export function StatTile({ icon, label, value, sub, tone, spark, sparkMax, big, text }: { icon?: string; label: string; value: ReactNode; sub?: ReactNode; tone?: "up" | "down" | "hot" | "warn"; spark?: number[]; sparkMax?: number; big?: boolean; /** a word rather than a number: smaller, wrapping */ text?: boolean }) {
  return (
    <div className={`d-tile ${tone ?? ""} ${big ? "big" : ""} ${text ? "text" : ""}`}>
      <div className="d-tile-label">{icon && <span aria-hidden>{icon} </span>}{label}</div>
      <div className="d-tile-value">{value}</div>
      {sub && <div className="d-tile-sub">{sub}</div>}
      {spark && spark.length > 1 && <Spark values={spark} max={sparkMax ?? Math.max(1, ...spark)} h={28} stretch className="d-tile-spark" />}
    </div>
  );
}

/** A number that glides to its target. */
export function Count({ value }: { value: number }) { const v = useTween(value, 500); return <>{Math.round(v)}</>; }

export function Countdown({ endAt, now, onClear }: { endAt: number; now: number; onClear: () => void }) {
  const left = (endAt - now) / 1000;
  const done = left <= 0;
  return (
    <div className={`d-timer ${!done && left <= 10 ? "urgent" : ""} ${done ? "done" : ""}`} role="timer" aria-live="off">
      <span className="d-timer-value">{done ? "TIME" : fmtCountdown(left)}</span>
      <button className="dc-btn" onClick={onClear} aria-label="clear timer" title="clear (t)">✕</button>
    </div>
  );
}

export interface Burst { id: string; emoji: string; text: string; handle?: string; avatar?: string }
/** Gift and follow celebrations: a pill with a little particle burst, bottom center. */
export function Bursts({ items }: { items: Burst[] }) {
  if (!items.length) return null;
  return (
    <div className="d-bursts" aria-live="polite" style={{ "--burst-ms": `${TIMING.burstMs}ms` } as React.CSSProperties}>
      {items.map((b) => (
        <div key={b.id} className="d-burst">
          <span className="d-burst-emoji" aria-hidden>{b.emoji}</span>
          {b.handle && <Avatar src={b.avatar} name={b.handle} handle={b.handle} size={30} className="d-burst-avatar" />}
          <span className="d-burst-text">{b.text}</span>
          <i className="p p1" aria-hidden>{b.emoji}</i><i className="p p2" aria-hidden>{b.emoji}</i><i className="p p3" aria-hidden>{b.emoji}</i><i className="p p4" aria-hidden>{b.emoji}</i>
        </div>
      ))}
    </div>
  );
}

/** The run of show: checkable lines the host wrote in the settings. */
export function NotesRail({ items, done, onToggle, onClose }: { items: NoteItem[]; done: Set<string>; onToggle: (key: string) => void; onClose: () => void }) {
  const total = items.filter((i) => i.checkable).length, checked = items.filter((i) => i.checkable && done.has(i.key)).length;
  return (
    <aside className="d-notes" aria-label="show notes">
      <header className="d-notes-head"><span>📋 Run of show</span>{total > 0 && <span className="d-notes-count">{checked}/{total}</span>}<span className="grow" /><button className="dc-btn" onClick={onClose} aria-label="hide notes" title="hide (n)">✕</button></header>
      {items.length === 0 && <p className="d-notes-empty">Write your plan in the settings (g): one line per item, start a line with “- ” for a checkbox.</p>}
      <ul>
        {items.map((it) => it.checkable
          ? <li key={it.key} className={done.has(it.key) ? "done" : ""}><label><input type="checkbox" checked={done.has(it.key)} onChange={() => onToggle(it.key)} /><span>{it.text}</span></label></li>
          : <li key={it.key} className="plain">{it.text}</li>)}
      </ul>
    </aside>
  );
}
