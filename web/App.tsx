import { useCallback, useEffect, useRef, useState } from "react";
import type { Highlight, RecordingInfo } from "@shared/protocol";
import { api, useSocket } from "./useSocket";
import { VideoPane } from "./components/VideoPane";
import { Gauges } from "./components/Gauges";
import { ChatFeed } from "./components/ChatFeed";
import { Transcript } from "./components/Transcript";
import { RulesPanel } from "./components/RulesPanel";
import { Versions } from "./components/Versions";
import { GlmLog } from "./components/GlmLog";
import { ActivityLog } from "./components/ActivityLog";
import { SettingsPanel } from "./components/Settings";
import { Recordings } from "./components/Recordings";
import { Timeline, ReviewStrip } from "./components/Timeline";
import type { MomentContext, SessionTimeline } from "@shared/protocol";
import { Flagged } from "./components/Flagged";
import { Toasts, chime } from "./components/Toasts";
import { Kbd, Spark } from "./components/ui";

type Tab = "flagged" | "rules" | "versions" | "glm" | "log" | "replays" | "state" | "settings";
const TABS: Tab[] = ["flagged", "rules", "versions", "glm", "log", "replays", "state", "settings"];

const pref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export function App() {
  const s = useSocket();
  const [username, setUsername] = useState("");
  const [tab, setTab] = useState<Tab>("flagged");
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [focusHighlight, setFocusHighlight] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [sound, setSound] = useState(() => pref("jev.sound", false));
  const [muted, setMuted] = useState(() => pref("jev.muted", true));
  const [help, setHelp] = useState(false);
  const lastToast = useRef<string | null>(null);
  const live = s.status?.state === "live";
  // Time-shift: the live session's timeline, where playback sits, and the moment under review.
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null);
  const [reviewTs, setReviewTs] = useState<number | null>(null);
  const [review, setReview] = useState<MomentContext | null>(null);
  const [playing, setPlaying] = useState<{ ts: number | null; behind: number }>({ ts: null, behind: 0 });
  const isReplay = !!s.replay;
  useEffect(() => {
    if (!live || isReplay) { setTimeline(null); setReviewTs(null); setReview(null); return; }
    let stop = false;
    const tick = () => api.timeline().then((t) => { if (!stop) setTimeline(t); }).catch(() => {});
    void tick();
    const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [live, isReplay]);
  const onPlayingTs = useCallback((ts: number | null, behind: number) => setPlaying({ ts, behind }), []);
  const seekTo = useCallback((ts: number) => {
    if (s.replay) { setReview(null); void api.seekReplay(Math.max(0, ts - s.replay.t0)); }
    else setReviewTs(ts);
  }, [s.replay]);
  const backToLive = useCallback(() => { setReviewTs(null); setReview(null); }, []);

  useEffect(() => { if (s.status?.username && !username) setUsername(s.status.username); }, [s.status?.username]);
  useEffect(() => { void api.recordings().then(setRecordings).catch(() => {}); }, [s.status?.state]);
  useEffect(() => { if (tab === "flagged") s.markSeen(); }, [tab, s.highlights.length]);
  useEffect(() => { const t = s.toasts.at(-1); if (t && t.id !== lastToast.current) { lastToast.current = t.id; if (sound) chime(); } }, [s.toasts, sound]);
  useEffect(() => save("jev.sound", sound), [sound]);
  useEffect(() => save("jev.muted", muted), [muted]);

  // Keyboard: 1-5 tabs, / search, m mute, s sound, ? help, esc close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") { setHelp(false); (document.activeElement as HTMLElement | null)?.blur(); return; }
      if (typing) return;
      if (e.key >= "1" && e.key <= "8") { setTab(TABS[Number(e.key) - 1]); return; }
      if (e.key === "r" && live) { void (s.recording.active ? api.stopRecording() : api.startRecording()); return; }
      if (e.key === ",") { setTab("settings"); return; }
      if (e.key === "/") { e.preventDefault(); setTab("flagged"); setTimeout(() => document.getElementById("hl-search")?.focus(), 0); return; }
      if (e.key === "m") setMuted((v) => !v);
      if (e.key === "s") setSound((v) => !v);
      if (e.key === "?") setHelp((v) => !v);
      if (e.key === "d") window.open("/?view=director", "jev-director", "width=1280,height=720");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, s.recording.active]);

  const openHighlight = useCallback((h: Highlight) => { setTab("flagged"); setFocusHighlight(h.id); s.dismissToast(h.id); }, [s.dismissToast]);
  const jumpToMessage = useCallback((id: string) => setFocusMessage(id), []);
  const openMessageHighlight = useCallback((messageId: string) => {
    const h = [...s.highlights].reverse().find((x) => x.message?.id === messageId);
    if (h) { setTab("flagged"); setFocusHighlight(h.id); }
  }, [s.highlights]);

  const windowQs = s.questions?.questions.filter((q) => q.scope === "window") ?? [];
  const messageQs = s.questions?.questions.filter((q) => q.scope === "message") ?? [];
  const allQs = s.questions?.questions ?? [];
  const last = s.decisions.at(-1);
  const glmBusy = s.glm.some((g) => g.status === "running");
  const firedNow = last?.fired.length ?? 0;
  const openCount = s.highlights.filter((h) => !h.resolved).length;
  const latencies = s.decisions.slice(-40).map((d) => d.latencyMs);
  const viewersSeries = s.decisions.slice(-40).map(() => s.snapshot?.activity.viewers ?? 0);
  const booted = s.status !== null;

  return (
    <div className={`app ${booted ? "" : "booting"} ${live && (s.replay || timeline) ? "replaying" : ""}`}>
      {!s.connected && booted && <div className="banner warn">Connection to the server lost. Reconnecting…</div>}
      <header className="topbar">
        <div className="brand" title="tiktok:jev"><span className="logo" aria-hidden>◎</span><span className="brand-name">tiktok<span className="brand-sep">:</span>jev</span></div>

        <div className="conn" role="group" aria-label="stream connection">
          <span className={`status-pill ${s.status?.state ?? "offline"}`} title={s.status?.detail ?? s.status?.state}>
            <span className="dot" /><span className="status-state">{s.status?.state ?? "offline"}</span>{s.status?.title ? <span className="status-title">{s.status.title}</span> : null}
          </span>
          <form className="connect" onSubmit={(e) => { e.preventDefault(); if (!live && username) void api.connect(username); }}>
            <span className="at">@</span>
            <input value={username.replace(/^@/, "")} onChange={(e) => setUsername(e.target.value)} placeholder="tiktok username" aria-label="tiktok username" disabled={live} />
            {live ? <button type="button" onClick={() => api.disconnect()}>Disconnect</button> : <button type="submit" className="primary" disabled={!username}>Connect</button>}
          </form>
          {recordings.length > 0 && !live && (
            <select className="replay" onChange={(e) => e.target.value && api.connect("replay", e.target.value)} defaultValue="" aria-label="replay a recording" title="replay a recorded session (🎥 = video available)">
              <option value="">replay…</option>
              {recordings.map((r) => <option key={r.id} value={r.events}>{r.videos.length ? "🎥 " : "· "}{r.username} · {new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{r.durationSec ? ` · ${Math.round(r.durationSec / 60)} min` : ""}{r.sizeBytes ? ` · ${(r.sizeBytes / 1e6).toFixed(0)} MB` : ""}</option>)}
            </select>
          )}
          {s.status?.state === "error" && <span className="conn-error" title={s.status.detail}>{s.status.detail}</span>}
        </div>

        <div className="kpis" aria-label="live metrics">
          <div className="kpi" title="jev round trip, last 40 ticks"><small>jev</small><b>{last ? last.latencyMs : "—"}<i>ms</i></b><Spark values={latencies} max={Math.max(600, ...latencies)} w={56} h={16} /></div>
          <div className="kpi" title="all model spend this session"><small>spend</small><b>${s.totalCost.toFixed(3)}</b></div>
          <div className="kpi optional" title="question set version · count"><small>questions</small><b>v{s.questions?.version ?? "–"}<i>· {allQs.length}</i></b></div>
          <div className="kpi" title="viewers"><small>viewers</small><b>{s.snapshot?.activity.viewers ?? "–"}</b><Spark values={viewersSeries} max={Math.max(1, ...viewersSeries)} w={56} h={16} /></div>
          <div className="kpi optional" title="chat velocity"><small>chat</small><b className="cap">{s.snapshot?.activity.chat_velocity ?? "–"}</b></div>
          <div className={`kpi ${glmBusy ? "busy" : ""}`} title="GLM prompt writer"><small>GLM</small><b>{glmBusy ? <><span className="spinner sm" /> writing</> : "idle"}</b></div>
        </div>

        <div className="actions">
          <button className="icon director-btn" title="open the director view for the host (d)" onClick={() => window.open("/?view=director", "jev-director", "width=1280,height=720")}><span aria-hidden>🎬</span><span className="label">director</span></button>
          <button className={`icon ${sound ? "on" : ""}`} title={`alert chime ${sound ? "on" : "off"} (s)`} onClick={() => setSound((v) => !v)} aria-pressed={sound}>{sound ? "🔔" : "🔕"}</button>
          <button className="icon" title="keyboard shortcuts (?)" onClick={() => setHelp((v) => !v)} aria-label="keyboard shortcuts">?</button>
          <span className={`dot ${s.connected ? "live" : "offline"}`} title={s.connected ? "connected to server" : "server unreachable"} />
        </div>
      </header>
      {live && (s.replay || timeline) && (
        <Timeline mode={s.replay ? { kind: "replay", replay: s.replay } : { kind: "live", timeline: timeline!, playingTs: playing.ts, behindSec: playing.behind, reviewTs }} highlights={s.highlights} onSeek={seekTo} onLive={backToLive} onReview={setReview} />
      )}
      {live && review && <ReviewStrip ctx={review} live={!s.replay} onClose={() => setReview(null)} onLive={backToLive} />}

      <main>
        <section className="col left" aria-label="stream">
          <VideoPane source={s.video} viewers={s.snapshot?.activity.viewers} title={s.status?.title} live={live} muted={muted} onToggleMute={() => setMuted((v) => !v)} recording={s.recording} onRecord={() => void (s.recording.active ? api.stopRecording() : api.startRecording())} reviewTs={reviewTs} onPlayingTs={onPlayingTs} />
          <Transcript lines={s.transcript} interim={s.interim} captions={s.captions} highlights={s.highlights} onOpen={openHighlight} />
        </section>

        <section className="col mid" aria-label="decisions">
          <div className="section-head"><h2>Room</h2><span className="muted">{windowQs.length} questions · every second</span><span className="grow" />{firedNow ? <span className="firing-pill">{firedNow} firing</span> : <span className="muted">quiet</span>}</div>
          <div className="gauges-scroll"><Gauges questions={windowQs} decisions={s.decisions} snapshot={s.snapshot} /></div>
          <div className="section-head"><h2>Chat</h2><span className="muted">{messageQs.length ? `each message judged on ${messageQs.map((q) => q.label).join(", ")}` : "no per-message rules"}</span></div>
          <ChatFeed chat={s.chat} decisions={s.messageDecisions} questions={messageQs} focusId={focusMessage} onOpenFlag={openMessageHighlight} />
        </section>

        <section className="col right" aria-label="control">
          <nav className="tabs" role="tablist">
            {TABS.map((t, i) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`${tab === t ? "active" : ""} ${t === "settings" ? "gear" : ""}`} onClick={() => setTab(t)} title={t === "settings" ? "settings (,)" : `${t} (${i + 1})`} aria-label={t}>
                {t === "settings" ? "⚙" : t}
                {t === "flagged" && openCount ? <span className={`count ${s.unseen.length ? "new" : ""}`}>{openCount}</span> : null}
                {t === "glm" && glmBusy ? <span className="pip" /> : null}
              </button>
            ))}
          </nav>
          <div className="tab-body" key={tab}>
            {tab === "flagged" && <Flagged highlights={s.highlights} questions={allQs} focusId={focusHighlight} onJump={jumpToMessage} />}
            {tab === "rules" && <RulesPanel rules={s.rules} questions={s.questions} compiling={glmBusy} />}
            {tab === "versions" && <Versions history={s.history} />}
            {tab === "glm" && <GlmLog items={s.glm} />}
            {tab === "log" && <ActivityLog entries={s.log} />}
            {tab === "replays" && <Recordings live={live} currentBase={s.recording.sessionId} replayOf={s.recording.replayOf} />}
            {tab === "settings" && <SettingsPanel settings={s.settings} live={live} sound={sound} setSound={setSound} muted={muted} setMuted={setMuted} />}
            {tab === "state" && <pre className="state">{s.snapshot ? JSON.stringify(s.snapshot, null, 1) : "no snapshot yet"}</pre>}
          </div>
        </section>
      </main>
      <Toasts toasts={s.toasts} onDismiss={s.dismissToast} onOpen={openHighlight} durationMs={s.settings?.timing.toastMs ?? 4500} />
      {help && (
        <div className="overlay" onClick={() => setHelp(false)} role="dialog" aria-label="keyboard shortcuts">
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard</h3>
            <dl>
              <dt><Kbd k="1" />…<Kbd k="8" /></dt><dd>switch panel</dd>
              <dt><Kbd k="r" /></dt><dd>start / stop video recording</dd>
              <dt><Kbd k="," /></dt><dd>settings</dd>
              <dt><Kbd k="d" /></dt><dd>open the director view</dd>
              <dt><Kbd k="/" /></dt><dd>search flagged</dd>
              <dt><Kbd k="m" /></dt><dd>mute / unmute stream</dd>
              <dt><Kbd k="s" /></dt><dd>alert chime on / off</dd>
              <dt><Kbd k="⌘⏎" /></dt><dd>add rule from the composer</dd>
              <dt><Kbd k="esc" /></dt><dd>close</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
