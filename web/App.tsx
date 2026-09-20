import { useCallback, useEffect, useRef, useState } from "react";
import type { Highlight } from "@shared/protocol";
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
import { Flagged } from "./components/Flagged";
import { Toasts, chime } from "./components/Toasts";
import { Kbd, Spark } from "./components/ui";

type Tab = "flagged" | "rules" | "versions" | "glm" | "log" | "state" | "settings";
const TABS: Tab[] = ["flagged", "rules", "versions", "glm", "log", "state", "settings"];

const pref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T); } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export function App() {
  const s = useSocket();
  const [username, setUsername] = useState("");
  const [tab, setTab] = useState<Tab>("flagged");
  const [recordings, setRecordings] = useState<string[]>([]);
  const [focusHighlight, setFocusHighlight] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [sound, setSound] = useState(() => pref("jev.sound", false));
  const [muted, setMuted] = useState(() => pref("jev.muted", true));
  const [help, setHelp] = useState(false);
  const lastToast = useRef<string | null>(null);

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
      if (e.key >= "1" && e.key <= "7") { setTab(TABS[Number(e.key) - 1]); return; }
      if (e.key === ",") { setTab("settings"); return; }
      if (e.key === "/") { e.preventDefault(); setTab("flagged"); setTimeout(() => document.getElementById("hl-search")?.focus(), 0); return; }
      if (e.key === "m") setMuted((v) => !v);
      if (e.key === "s") setSound((v) => !v);
      if (e.key === "?") setHelp((v) => !v);
      if (e.key === "d") window.open("/?view=director", "jev-director", "width=1280,height=720");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const live = s.status?.state === "live";
  const glmBusy = s.glm.some((g) => g.status === "running");
  const firedNow = last?.fired.length ?? 0;
  const openCount = s.highlights.filter((h) => !h.resolved).length;
  const latencies = s.decisions.slice(-40).map((d) => d.latencyMs);
  const viewersSeries = s.decisions.slice(-40).map(() => s.snapshot?.activity.viewers ?? 0);
  const booted = s.status !== null;

  return (
    <div className={`app ${booted ? "" : "booting"}`}>
      {!s.connected && booted && <div className="banner warn">Connection to the server lost. Reconnecting…</div>}
      <header>
        <div className="brand"><span className="logo" aria-hidden>◎</span><span>awesome-jev</span><span className="tagline">jev decides every second · GLM rewrites the questions</span></div>
        <div className="conn">
          <span className={`status-pill ${s.status?.state ?? "offline"}`} title={s.status?.detail}>
            <span className="dot" />{s.status?.state ?? "offline"}{s.status?.title ? <span className="status-title"> · {s.status.title}</span> : null}
          </span>
          {s.status?.state === "error" && <span className="error small">{s.status.detail}</span>}
          <form className="connect" onSubmit={(e) => { e.preventDefault(); if (!live && username) void api.connect(username); }}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@tiktok username" aria-label="tiktok username" disabled={live} />
            {live ? <button type="button" onClick={() => api.disconnect()}>Disconnect</button> : <button type="submit" className="primary" disabled={!username}>Connect</button>}
          </form>
          {recordings.length > 0 && !live && (
            <select onChange={(e) => e.target.value && api.connect("replay", e.target.value)} defaultValue="" aria-label="replay a recording">
              <option value="">replay…</option>
              {recordings.map((r) => <option key={r} value={r}>{r.replace("recordings/", "")}</option>)}
            </select>
          )}
        </div>
        <div className="kpis">
          <div className="kpi" title="jev round trip, last 40 ticks"><small>jev</small><b>{last ? `${last.latencyMs}` : "—"}<i>ms</i></b><Spark values={latencies} max={Math.max(600, ...latencies)} w={64} h={18} /></div>
          <div className="kpi" title="all model spend this session (jev + GLM + vision)"><small>spend</small><b>${s.totalCost.toFixed(4)}</b></div>
          <div className="kpi" title="question set version"><small>questions</small><b>v{s.questions?.version ?? "–"}<i>· {allQs.length}</i></b></div>
          <div className="kpi" title="viewers"><small>viewers</small><b>{s.snapshot?.activity.viewers ?? "–"}</b><Spark values={viewersSeries} max={Math.max(1, ...viewersSeries)} w={64} h={18} /></div>
          <div className="kpi" title="chat velocity"><small>chat</small><b className="cap">{s.snapshot?.activity.chat_velocity ?? "–"}</b></div>
          <div className={`kpi ${glmBusy ? "busy" : ""}`} title="GLM prompt writer"><small>GLM</small><b>{glmBusy ? <><span className="spinner sm" /> writing</> : "idle"}</b></div>
          <div className="kpi-actions">
            <button className={`icon ${sound ? "on" : ""}`} title={`alert sound ${sound ? "on" : "off"} (s)`} onClick={() => setSound((v) => !v)} aria-pressed={sound}>{sound ? "🔔" : "🔕"}</button>
            <button className="icon director-btn" title="open director view for the host (d)" onClick={() => window.open("/?view=director", "jev-director", "width=1280,height=720")}>🎬 director</button>
            <button className="icon" title="keyboard shortcuts (?)" onClick={() => setHelp((v) => !v)}>?</button>
            <span className={`dot ${s.connected ? "live" : "offline"}`} title={s.connected ? "connected to server" : "disconnected"} />
          </div>
        </div>
      </header>

      <main>
        <section className="col left" aria-label="stream">
          <VideoPane url={s.hlsUrl} viewers={s.snapshot?.activity.viewers} title={s.status?.title} live={live} muted={muted} onToggleMute={() => setMuted((v) => !v)} />
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
              <dt><Kbd k="1" />…<Kbd k="7" /></dt><dd>switch panel</dd>
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
