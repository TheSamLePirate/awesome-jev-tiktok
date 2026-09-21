import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, WatchQuestion } from "@shared/protocol";
import { api } from "./lib/api";
import { usePref } from "./lib/prefs";
import { useHotkeys, type Hotkey } from "./lib/hotkeys";
import { chime } from "./lib/audio";
import { useStore } from "./lib/store";
import { Avatar, Kbd, useNow } from "./components/ui";
import { DialogHost, prompt } from "./components/Dialog";
import { DEFAULT_PREFS, LAYOUTS, TIMING, audience, avatarIndex, fmtElapsed, parseCountdown, parseNotes, ruleRows, selectCards, urlOverrides, viewerStats, waitingCount, type DirectorPrefs, type Layout } from "./director/model";
import { Bursts, Countdown, NotesRail, usePresence, type Burst, type CardActions } from "./director/widgets";
import { DashboardView, FocusView, OverlayView, RecapView, StageView, type MeterData, type Stats, type ViewData } from "./director/views";

/**
 * The host's second screen (a tablet beside the camera, a monitor, or an OBS browser source). Four layouts, a prompt
 * queue driven from the keyboard, a countdown, the run of show, and celebrations for gifts and follows. Its
 * preferences live in this browser; URL options (?layout=overlay&transparent=1&warnings=0) apply to one source only.
 */
export function Director() {
  const now = useNow(1000);
  const [saved, setSaved] = usePref<DirectorPrefs>("jev.director", DEFAULT_PREFS);
  const overrides = useMemo(() => urlOverrides(location.search), []);
  const prefs: DirectorPrefs = { ...DEFAULT_PREFS, ...saved, ...overrides };
  const setPrefs = useCallback((p: Partial<DirectorPrefs>) => setSaved((s) => ({ ...DEFAULT_PREFS, ...s, ...p })), [setSaved]);
  const [panel, setPanel] = useState(false);
  const [help, setHelp] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [snoozed, setSnoozed] = useState<Map<string, number>>(() => new Map());
  const [timerEnd, setTimerEnd] = useState<number | null>(null);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [awake, setAwake] = useState(false);
  const wakeLock = useRef<{ release: () => Promise<void>; addEventListener?: (t: string, f: () => void) => void } | null>(null);
  useEffect(() => { document.body.classList.toggle("transparent", prefs.transparent); return () => document.body.classList.remove("transparent"); }, [prefs.transparent]);

  const status = useStore((s) => s.status);
  const connected = useStore((s) => s.connected);
  const replay = useStore((s) => s.replay);
  const summary = useStore((s) => s.summary);
  const highlights = useStore((s) => s.highlights);
  const allQs = useStore((s) => s.questions?.questions ?? []);
  const decisions = useStore((s) => s.decisions);
  const last = decisions.at(-1);
  const snapshot = useStore((s) => s.snapshot);
  const health = useStore((s) => s.health);
  const social = useStore((s) => s.social);
  const viewers = useStore((s) => s.viewers);
  const allChat = useStore((s) => s.chat);
  const messageDecisions = useStore((s) => s.messageDecisions);
  const ruleList = useStore((s) => s.rules);
  const sessionId = useStore((s) => s.sessionId);
  const chat = useMemo(() => allChat.slice(-4).map((m) => ({ id: m.id, handle: m.handle, name: m.nickname || m.handle, text: m.text, hot: !!messageDecisions[m.id]?.fired.length, avatar: m.avatar })), [allChat, messageDecisions]);
  const avatars = useMemo(() => avatarIndex(allChat), [allChat]);

  // The queue and what the stage says when it is empty.
  const hidden = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const cards = useMemo(() => selectCards(highlights, { hidden, showWarnings: prefs.showWarnings, ttlSec: prefs.ttlSec, maxCards: prefs.maxCards, order: prefs.order, snoozed, now }), [highlights, hidden, prefs.showWarnings, prefs.ttlSec, prefs.maxCards, prefs.order, snoozed, now]);
  const present = usePresence(cards, (h) => h.id);
  const selectedId = cards.some((c) => c.id === selected) ? selected : (cards[0]?.id ?? null);
  const waiting = useMemo(() => waitingCount(highlights, hidden, now), [highlights, hidden, now]);
  // Every rule of the active set for the dashboard; the stage keeps a few room meters.
  const rules = useMemo(() => ruleRows(allQs, { rules: ruleList, decisions, messageDecisions, highlights, sessionId, hidden }), [allQs, ruleList, decisions, messageDecisions, highlights, sessionId, hidden]);
  const meters = useMemo<MeterData[]>(() => rules.filter((r) => r.scope === "window" && !r.muted).slice(0, 5).map((r) => ({ id: r.id, label: r.label, answer: r.answer, fired: r.fired, skipped: r.skipped, history: r.history })), [rules]);

  // Honest state: LIVE only when the server socket is up AND the stream is live; otherwise say what is wrong.
  const live = connected && status?.state === "live";
  // A replayed decision can carry a clock a second ahead of this screen: never show a negative age.
  const decisionAge = last ? Math.max(0, Math.round((now - last.ts) / 1000)) : null;
  const stale = live && (decisionAge === null || decisionAge > 10);
  const sourcesDown = snapshot ? (Object.entries(snapshot.sources) as [string, { state: string }][]).filter(([, h]) => h.state === "error" || h.state === "missing").map(([k]) => k) : [];
  const paused = !!(health?.breaker && health.breaker.until > now) || !!health?.budget.stopped;
  const watch = useStore((s) => s.watch);
  const stateLabel = !connected ? "console offline" : status?.state !== "live" ? (status?.state ?? "offline") : paused ? "paid calls paused" : stale ? "no decision" : "LIVE";
  const idle = { title: !live ? (connected && watch?.armed ? `waiting for @${watch.username}` : stateLabel) : paused ? "decisions paused" : stale ? "waiting for decisions" : "nothing to act on", detail: live && last ? `last decision ${decisionAge} s ago${sourcesDown.length ? ` · ${sourcesDown.join(", ")} unavailable` : ""}` : connected && !live && watch?.armed ? (watch.detail ?? "the console connects on its own when the live starts") : (status?.detail ?? "") };
  const stats = useMemo<Stats>(() => ({ elapsedMs: live && status ? now - status.ts : null, viewers: viewerStats(viewers, now), viewerSeries: viewers.map((v) => v.count), velocity: snapshot?.activity.chat_velocity ?? "–", likes: snapshot?.activity.likes_last_30s ?? "–", audience: audience(social), decisionAgeSec: decisionAge, latencyMs: last && !last.cached ? last.latencyMs : null }), [live, status, now, viewers, snapshot, social, decisionAge, last]);

  // Actions on a prompt: done and feature go to the server (every screen agrees); snooze is local to this screen.
  const done = useCallback((h: Highlight) => { void api.patchHighlight(h.id, { resolved: true }).catch(() => {}); }, []);
  const pin = useCallback((h: Highlight) => { void api.patchHighlight(h.id, { pinned: !h.pinned }).catch(() => {}); }, []);
  const snooze = useCallback((h: Highlight) => { setSnoozed((m) => new Map(m).set(h.id, Date.now() + prefs.snoozeMin * 60_000)); }, [prefs.snoozeMin]);
  const select = useCallback((h: Highlight) => setSelected(h.id), []);
  const actions = useMemo<CardActions>(() => ({ onDone: done, onPin: pin, onSnooze: snooze, onSelect: select }), [done, pin, snooze, select]);
  const selectedCard = cards.find((c) => c.id === selectedId) ?? null;
  const move = useCallback((step: number) => { if (!cards.length) return; const i = cards.findIndex((c) => c.id === selectedId); setSelected(cards[(i + step + cards.length) % cards.length].id); }, [cards, selectedId]);

  // A chime for each new prompt, and a celebration pill for each gift / follow.
  const seenCards = useRef<Set<string> | null>(null);
  useEffect(() => {
    // What is already on stage when this screen opens is not "new".
    if (!seenCards.current) { seenCards.current = new Set(cards.map((c) => c.id)); return; }
    const fresh = cards.filter((c) => !seenCards.current!.has(c.id));
    for (const c of cards) seenCards.current.add(c.id);
    if (fresh.length && prefs.sound) chime(fresh.some((c) => c.severity === "warn") ? "warn" : "info");
  }, [cards, prefs.sound]);
  const seenSocial = useRef<number | null>(null);
  useEffect(() => {
    if (seenSocial.current === null) { seenSocial.current = social.length; return; }
    const fresh = social.slice(seenSocial.current);
    seenSocial.current = social.length;
    if (!prefs.celebrations || !fresh.length) return;
    const add = fresh.flatMap((e, i): Burst[] => e.kind === "gift" ? [{ id: `${e.ts}-${i}`, emoji: "🎁", handle: e.handle, avatar: e.avatar ?? avatars.get(e.handle), text: `${e.nickname || e.handle} sent ${e.giftName}${e.count > 1 ? ` ×${e.count}` : ""} · 💎 ${e.diamonds * e.count}` }] : e.kind === "social" && e.action === "follow" ? [{ id: `${e.ts}-${i}`, emoji: "➕", handle: e.handle, avatar: e.avatar ?? avatars.get(e.handle), text: `${e.nickname || e.handle} followed` }] : []);
    if (!add.length) return;
    setBursts((b) => [...b, ...add].slice(-3));
    setTimeout(() => setBursts((b) => b.filter((x) => !add.some((a) => a.id === x.id))), TIMING.burstMs);
  }, [social, prefs.celebrations, avatars]);

  // Countdown: chime when it ends, keep "TIME" on screen a moment, then clear.
  const rang = useRef(false);
  useEffect(() => {
    if (timerEnd === null) { rang.current = false; return; }
    if (now < timerEnd || rang.current) return;
    rang.current = true;
    chime("warn");
    const t = setTimeout(() => setTimerEnd(null), TIMING.timerLingerMs);
    return () => clearTimeout(t);
  }, [timerEnd, now]);
  const startTimer = useCallback(async () => {
    if (timerEnd !== null) { setTimerEnd(null); return; }
    const r = await prompt({ title: "Countdown", body: "Minutes, m:ss or seconds: 5, 2:30, 45s.", initial: "5:00", multiline: false, confirmLabel: "Start" });
    const sec = r ? parseCountdown(r.text) : null;
    if (sec !== null) setTimerEnd(Date.now() + sec * 1000);
  }, [timerEnd]);

  // Full screen and wake lock for a tablet by the camera.
  useEffect(() => { const h = () => setFullscreen(!!document.fullscreenElement); document.addEventListener("fullscreenchange", h); return () => document.removeEventListener("fullscreenchange", h); }, []);
  const toggleFullscreen = useCallback(() => { void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); }, []);
  const toggleAwake = useCallback(async () => {
    if (wakeLock.current) { await wakeLock.current.release().catch(() => {}); wakeLock.current = null; setAwake(false); return; }
    try {
      const lock = await (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void>; addEventListener?: (t: string, f: () => void) => void }> } }).wakeLock?.request("screen");
      if (!lock) return;
      wakeLock.current = lock;
      lock.addEventListener?.("release", () => { wakeLock.current = null; setAwake(false); });
      setAwake(true);
    } catch { setAwake(false); }
  }, []);

  const setLayout = useCallback((layout: Layout) => setPrefs({ layout }), [setPrefs]);
  // An OBS source is told its layout by the URL and cannot leave it; a person can, with the button or esc.
  const overlayLocked = overrides.layout === "overlay";
  const exitOverlay = useCallback(() => setLayout("stage"), [setLayout]);
  const hotkeys = useMemo<Hotkey[]>(() => [
    { key: "Escape", label: "esc", help: "close panels / leave the overlay", global: true, run: () => { if (!panel && !help && prefs.layout === "overlay" && !overlayLocked) exitOverlay(); setPanel(false); setHelp(false); } },
    ...LAYOUTS.map((l, i): Hotkey => ({ key: String(i + 1), label: String(i + 1), help: `${l.label} view`, run: () => setLayout(l.id) })),
    { key: "Enter", label: "↵", help: "prompt done", when: () => !!selectedCard, run: () => { if (selectedCard) done(selectedCard); } },
    { key: "x", label: "x", help: "prompt done", when: () => !!selectedCard, run: () => { if (selectedCard) done(selectedCard); } },
    { key: "f", label: "f", help: "feature / unfeature the prompt", when: () => !!selectedCard, run: () => { if (selectedCard) pin(selectedCard); } },
    { key: "z", label: "z", help: "snooze the prompt", when: () => !!selectedCard, run: () => { if (selectedCard) snooze(selectedCard); } },
    { key: "ArrowDown", label: "↓", help: "next prompt", run: () => move(1) },
    { key: "ArrowUp", label: "↑", help: "previous prompt", run: () => move(-1) },
    { key: "j", label: "j", help: "next prompt", run: () => move(1) },
    { key: "k", label: "k", help: "previous prompt", run: () => move(-1) },
    { key: "n", label: "n", help: "run of show", run: () => setPrefs({ showNotes: !prefs.showNotes }) },
    { key: "t", label: "t", help: "countdown start / clear", run: () => void startTimer() },
    { key: "m", label: "m", help: "room meters", run: () => setPrefs({ showMeters: !prefs.showMeters }) },
    { key: "c", label: "c", help: "chat ticker", run: () => setPrefs({ showChat: !prefs.showChat }) },
    { key: "s", label: "s", help: "sound on new prompts", run: () => setPrefs({ sound: !prefs.sound }) },
    { key: "w", label: "w", help: "keep the screen awake", run: () => void toggleAwake() },
    { key: "F", label: "⇧F", help: "full screen", run: toggleFullscreen },
    { key: "g", label: "g", help: "settings", run: () => setPanel((v) => !v) },
    { key: "?", label: "?", help: "this help", run: () => setHelp((v) => !v) },
  ], [selectedCard, done, pin, snooze, move, panel, help, prefs.layout, prefs.showNotes, prefs.showMeters, prefs.showChat, prefs.sound, overlayLocked, exitOverlay, setPrefs, setLayout, startTimer, toggleAwake, toggleFullscreen]);
  useHotkeys(hotkeys);
  // oxlint-disable-next-line react/refs
  const helpRows = useMemo(() => hotkeys.filter((h) => h.key !== "Escape" && h.key !== "x" && h.key !== "j" && h.key !== "k"), [hotkeys]);

  const layout = prefs.layout;
  const notes = useMemo(() => parseNotes(prefs.notes), [prefs.notes]);
  const notesDone = useMemo(() => new Set(prefs.notesDone), [prefs.notesDone]);
  const toggleNote = useCallback((key: string) => setPrefs({ notesDone: notesDone.has(key) ? prefs.notesDone.filter((k) => k !== key) : [...prefs.notesDone, key] }), [notesDone, prefs.notesDone, setPrefs]);
  const data: ViewData = { cards: present, queueLength: cards.length, meters, rules, stats, chat, events: social, avatars, now, prefs, selectedId, live, idle };
  const recap = !live && !!summary && layout !== "overlay";
  const chart = useMemo(() => viewers.map((v) => v.count), [viewers]);

  return (
    <div className={`director layout-${layout} ${prefs.transparent ? "transparent" : ""} ${live ? "on-air" : ""}`} style={{ fontSize: `${16 * prefs.scale}px` }}>
      {layout !== "overlay" && (
        <TopBar stateLabel={stateLabel} live={live} warn={paused || stale} replay={!!replay} elapsed={prefs.showClock && stats.elapsedMs !== null ? fmtElapsed(stats.elapsedMs) : null} viewers={stats.viewers} velocity={stats.velocity} waiting={waiting} sourcesDown={sourcesDown} follows={stats.audience.follows} diamonds={stats.audience.diamonds} layout={layout} onLayout={setLayout}
          tools={{ notes: prefs.showNotes, sound: prefs.sound, awake, fullscreen, timer: timerEnd !== null }} onNotes={() => setPrefs({ showNotes: !prefs.showNotes })} onTimer={() => void startTimer()} onSound={() => setPrefs({ sound: !prefs.sound })} onAwake={() => void toggleAwake()} onFullscreen={toggleFullscreen} onHelp={() => setHelp((v) => !v)} onSettings={() => setPanel((v) => !v)} />
      )}
      {timerEnd !== null && <Countdown endAt={timerEnd} now={now} onClear={() => setTimerEnd(null)} />}
      <main className={`d-stage ${prefs.showNotes && layout !== "overlay" ? "with-notes" : ""}`}>
        <div className="d-view">
          {recap ? <RecapView summary={summary!} status={status} chart={chart} /> : layout === "focus" ? <FocusView data={data} actions={actions} /> : layout === "dashboard" ? <DashboardView data={data} actions={actions} /> : layout === "overlay" ? <OverlayView data={data} onExit={overlayLocked ? undefined : exitOverlay} /> : <StageView data={data} actions={actions} />}
        </div>
        {prefs.showNotes && layout !== "overlay" && <NotesRail items={notes} done={notesDone} onToggle={toggleNote} onClose={() => setPrefs({ showNotes: false })} />}
      </main>
      {prefs.showChat && chat.length > 0 && layout !== "dashboard" && (
        <footer className="d-chat" aria-label="latest chat">
          {chat.map((m) => <span key={m.id} className={m.hot ? "hot" : ""}><Avatar src={m.avatar} name={m.name} handle={m.handle} size={20} className="d-chat-avatar" /><b>{m.name}</b><em>{m.text}</em></span>)}
        </footer>
      )}
      <Bursts items={bursts} />
      {panel && <SettingsPanel prefs={prefs} setPrefs={setPrefs} allQs={allQs} hidden={hidden} onClose={() => setPanel(false)} />}
      {help && (
        <div className="overlay" onClick={() => setHelp(false)} role="presentation">
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
          <div className="sheet d-help-sheet" role="dialog" aria-modal="true" aria-label="keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard</h3>
            <dl>{helpRows.map((row) => <span key={row.key} className="contents"><dt><Kbd k={row.label} /></dt><dd>{row.help}</dd></span>)}<dt><Kbd k="esc" /></dt><dd>close</dd></dl>
          </div>
        </div>
      )}
      <DialogHost />
    </div>
  );
}

interface Tools { notes: boolean; sound: boolean; awake: boolean; fullscreen: boolean; timer: boolean }
const TopBar = memo(function TopBar({ stateLabel, live, warn, replay, elapsed, viewers, velocity, waiting, sourcesDown, follows, diamonds, layout, onLayout, tools, onNotes, onTimer, onSound, onAwake, onFullscreen, onHelp, onSettings }: {
  stateLabel: string; live: boolean; warn: boolean; replay: boolean; elapsed: string | null; viewers: ViewData["stats"]["viewers"]; velocity: string; waiting: number; sourcesDown: string[]; follows: number; diamonds: number;
  layout: Layout; onLayout: (l: Layout) => void; tools: Tools; onNotes: () => void; onTimer: () => void; onSound: () => void; onAwake: () => void; onFullscreen: () => void; onHelp: () => void; onSettings: () => void;
}) {
  const trend = viewers.trend === "up" ? "↗" : viewers.trend === "down" ? "↘" : "";
  return (
    <header className="d-top">
      <span className={`d-live ${live && !warn ? "on" : ""} ${warn ? "warn" : ""}`}><i />{stateLabel}</span>
      {replay && <span className="d-stat d-replay">REPLAY</span>}
      {elapsed && <span className="d-stat d-clock" title="on air">{elapsed}</span>}
      {viewers.current !== null && <span className={`d-stat ${viewers.trend}`} title={viewers.delta === null ? "viewers" : `${viewers.delta >= 0 ? "+" : ""}${viewers.delta} in 5 min · peak ${viewers.peak}`}>👁 {viewers.current}{trend && <em>{trend}</em>}</span>}
      {velocity !== "–" && <span className="d-stat cap" title="chat pace">💬 {velocity}</span>}
      {follows > 0 && <span className="d-stat" title="new follows this session">➕ {follows}</span>}
      {diamonds > 0 && <span className="d-stat" title="diamonds this session">💎 {diamonds}</span>}
      {waiting > 0 && <span className="d-stat hot">{waiting} waiting</span>}
      {sourcesDown.length > 0 && <span className="d-stat warn" title={sourcesDown.join(", ")}>{sourcesDown.map((s) => (s === "transcript" ? "🎙" : s === "video" ? "🎥" : "💬")).join(" ")} unavailable</span>}
      <span className="grow" />
      <nav className="d-switch" aria-label="layout">
        {LAYOUTS.map((l, i) => <button key={l.id} className={layout === l.id ? "on" : ""} aria-pressed={layout === l.id} onClick={() => onLayout(l.id)} title={`${l.label}: ${l.hint} (${i + 1})`}><span aria-hidden>{l.icon}</span><span className="d-switch-label">{l.label}</span></button>)}
      </nav>
      <div className="d-tools">
        <button className={tools.notes ? "on" : ""} onClick={onNotes} title="run of show (n)" aria-label="run of show" aria-pressed={tools.notes}>📋</button>
        <button className={tools.timer ? "on" : ""} onClick={onTimer} title="countdown (t)" aria-label="countdown" aria-pressed={tools.timer}>⏱</button>
        <button className={tools.sound ? "on" : ""} onClick={onSound} title={`sound on new prompts ${tools.sound ? "on" : "off"} (s)`} aria-label="sound" aria-pressed={tools.sound}>{tools.sound ? "🔔" : "🔕"}</button>
        <button className={tools.awake ? "on" : ""} onClick={onAwake} title={`keep the screen awake ${tools.awake ? "on" : "off"} (w)`} aria-label="keep awake" aria-pressed={tools.awake}>☀</button>
        <button className={tools.fullscreen ? "on" : ""} onClick={onFullscreen} title="full screen (⇧F)" aria-label="full screen" aria-pressed={tools.fullscreen}>⛶</button>
        <button onClick={onHelp} title="keyboard shortcuts (?)" aria-label="keyboard shortcuts">?</button>
        <button className="d-gear" onClick={onSettings} title="director settings (g)" aria-label="director settings">⚙</button>
      </div>
    </header>
  );
});

const SettingsPanel = memo(function SettingsPanel({ prefs, setPrefs, allQs, hidden, onClose }: { prefs: DirectorPrefs; setPrefs: (p: Partial<DirectorPrefs>) => void; allQs: WatchQuestion[]; hidden: Set<string>; onClose: () => void }) {
  return (
    <div className="d-panel" role="dialog" aria-label="director settings">
      <header className="d-panel-head"><h3>Director view</h3><span className="grow" /><button className="dc-btn" onClick={onClose} aria-label="close settings">✕</button></header>
      <div className="d-panel-row">
        <span>Layout</span>
        <div className="d-switch inline">{LAYOUTS.map((l) => <button key={l.id} className={prefs.layout === l.id ? "on" : ""} onClick={() => setPrefs({ layout: l.id })}>{l.icon} {l.label}</button>)}</div>
      </div>
      <div className="d-panel-row">
        <span>Queue order</span>
        <div className="d-switch inline"><button className={prefs.order === "newest" ? "on" : ""} onClick={() => setPrefs({ order: "newest" })}>newest first</button><button className={prefs.order === "oldest" ? "on" : ""} onClick={() => setPrefs({ order: "oldest" })}>oldest first</button></div>
      </div>
      <label>Prompt lifetime <input type="range" min={10} max={300} step={5} value={prefs.ttlSec} onChange={(e) => setPrefs({ ttlSec: Number(e.target.value) })} /><b>{prefs.ttlSec}s</b></label>
      <label>Max prompts <input type="range" min={1} max={8} step={1} value={prefs.maxCards} onChange={(e) => setPrefs({ maxCards: Number(e.target.value) })} /><b>{prefs.maxCards}</b></label>
      <label>Snooze <input type="range" min={1} max={15} step={1} value={prefs.snoozeMin} onChange={(e) => setPrefs({ snoozeMin: Number(e.target.value) })} /><b>{prefs.snoozeMin} min</b></label>
      <label>Scale <input type="range" min={0.7} max={2.2} step={0.1} value={prefs.scale} onChange={(e) => setPrefs({ scale: Number(e.target.value) })} /><b>{prefs.scale.toFixed(1)}×</b></label>
      <div className="d-panel-grid">
        <label className="row"><input type="checkbox" checked={prefs.showMeters} onChange={(e) => setPrefs({ showMeters: e.target.checked })} /> room meters</label>
        <label className="row"><input type="checkbox" checked={prefs.showChat} onChange={(e) => setPrefs({ showChat: e.target.checked })} /> chat ticker</label>
        <label className="row"><input type="checkbox" checked={prefs.showClock} onChange={(e) => setPrefs({ showClock: e.target.checked })} /> on-air clock</label>
        <label className="row"><input type="checkbox" checked={prefs.sound} onChange={(e) => setPrefs({ sound: e.target.checked })} /> sound on new prompts</label>
        <label className="row"><input type="checkbox" checked={prefs.celebrations} onChange={(e) => setPrefs({ celebrations: e.target.checked })} /> gift &amp; follow celebrations</label>
        <label className="row"><input type="checkbox" checked={prefs.showWarnings} onChange={(e) => setPrefs({ showWarnings: e.target.checked })} /> moderation warnings <small>(off for a public overlay)</small></label>
        <label className="row"><input type="checkbox" checked={prefs.transparent} onChange={(e) => setPrefs({ transparent: e.target.checked })} /> transparent background (OBS)</label>
      </div>
      <label className="d-panel-notes">Run of show <small>one line per item, “- ” for a checkbox</small>
        <textarea name="run-of-show" value={prefs.notes} rows={4} autoComplete="off" data-1p-ignore="true" data-lpignore="true" placeholder={"- Say hello and the topic\n- Giveaway at 30 min\n- Read the questions"} onChange={(e) => setPrefs({ notes: e.target.value })} aria-label="run of show" />
      </label>
      <div className="d-qs">
        <span>Show prompts from</span>
        {allQs.map((q) => <label key={q.id} className="row"><input type="checkbox" checked={!hidden.has(q.id)} onChange={(e) => setPrefs({ hidden: e.target.checked ? prefs.hidden.filter((x) => x !== q.id) : [...prefs.hidden, q.id] })} /> {q.label} <small>{q.scope === "message" ? "chat" : "room"}</small></label>)}
      </div>
      <p className="d-help">OBS: add <code>{location.origin}/?view=director&layout=overlay&transparent=1&warnings=0</code> as a browser source; URL options apply to that source only. A public overlay should never show moderation warnings or private notes.</p>
    </div>
  );
});
