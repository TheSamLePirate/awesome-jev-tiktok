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
import { Flagged } from "./components/Flagged";
import { Toasts, chime } from "./components/Toasts";

type Tab = "flagged" | "rules" | "versions" | "glm" | "state";

export function App() {
  const s = useSocket();
  const [username, setUsername] = useState("");
  const [tab, setTab] = useState<Tab>("flagged");
  const [recordings, setRecordings] = useState<string[]>([]);
  const [focusHighlight, setFocusHighlight] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem("jev.sound") === "1"; } catch { return false; } });
  const lastToast = useRef<string | null>(null);

  useEffect(() => { if (s.status?.username && !username) setUsername(s.status.username); }, [s.status?.username]);
  useEffect(() => { void api.recordings().then(setRecordings).catch(() => {}); }, [s.status?.state]);
  useEffect(() => { if (tab === "flagged") s.markSeen(); }, [tab, s.highlights.length]);
  useEffect(() => {
    const t = s.toasts.at(-1);
    if (t && t.id !== lastToast.current) { lastToast.current = t.id; if (sound) chime(); }
  }, [s.toasts, sound]);
  useEffect(() => { try { localStorage.setItem("jev.sound", sound ? "1" : "0"); } catch {} }, [sound]);

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

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo">◎</span> awesome-jev <span className="tagline">jev decides every second · GLM rewrites the questions</span></div>
        <div className="conn">
          <span className={`dot ${s.status?.state ?? "offline"}`} title={s.status?.detail} />
          <span className="status-text">{s.status?.state ?? "offline"}{s.status?.title ? ` · ${s.status.title}` : ""}{s.status?.state === "error" ? ` · ${s.status.detail}` : ""}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@tiktok username" />
          {live ? <button onClick={() => api.disconnect()}>Disconnect</button> : <button className="primary" onClick={() => api.connect(username)} disabled={!username}>Connect</button>}
          {recordings.length > 0 && !live && (
            <select onChange={(e) => e.target.value && api.connect("replay", e.target.value)} defaultValue="">
              <option value="">replay a recording…</option>
              {recordings.map((r) => <option key={r} value={r}>{r.replace("recordings/", "")}</option>)}
            </select>
          )}
        </div>
        <div className="stats">
          <span className="stat"><b>{last ? `${last.latencyMs} ms` : "—"}</b><small>jev</small></span>
          <span className="stat"><b>${s.totalCost.toFixed(4)}</b><small>spend</small></span>
          <span className="stat"><b>v{s.questions?.version ?? "–"} · {allQs.length}</b><small>questions</small></span>
          <span className="stat"><b>{s.snapshot?.activity.viewers ?? "–"}</b><small>viewers</small></span>
          <span className="stat"><b>{s.snapshot?.activity.chat_velocity ?? "–"}</b><small>chat</small></span>
          <span className={`stat glm ${glmBusy ? "busy" : ""}`}><b>{glmBusy ? "writing" : "idle"}</b><small>GLM</small></span>
          <button className={`icon sound ${sound ? "on" : ""}`} title={sound ? "sound on" : "sound off"} onClick={() => setSound((v) => !v)}>{sound ? "🔔" : "🔕"}</button>
          <span className={`dot ${s.connected ? "live" : "offline"}`} title="ui socket" />
        </div>
      </header>

      <main>
        <section className="col left">
          <VideoPane url={s.hlsUrl} />
          <Transcript lines={s.transcript} interim={s.interim} captions={s.captions} highlights={s.highlights} onOpen={openHighlight} />
        </section>

        <section className="col mid">
          <div className="section-head"><h2>Room</h2><span className="muted">{windowQs.length} questions · every second · {firedNow ? <b className="hot">{firedNow} firing</b> : "quiet"}</span></div>
          <div className="gauges-scroll"><Gauges questions={windowQs} decisions={s.decisions} snapshot={s.snapshot} /></div>
          <div className="section-head"><h2>Chat</h2><span className="muted">{messageQs.length ? `each message judged on ${messageQs.map((q) => q.label).join(", ")}` : "no per-message rules"}</span></div>
          <ChatFeed chat={s.chat} decisions={s.messageDecisions} questions={messageQs} focusId={focusMessage} onOpenFlag={openMessageHighlight} />
        </section>

        <section className="col right">
          <nav className="tabs">
            {(["flagged", "rules", "versions", "glm", "state"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t}
                {t === "flagged" && openCount ? <span className={`count ${s.unseen.length ? "new" : ""}`}>{openCount}</span> : null}
                {t === "glm" && glmBusy ? <span className="pip" /> : null}
              </button>
            ))}
          </nav>
          {tab === "flagged" && <Flagged highlights={s.highlights} questions={allQs} focusId={focusHighlight} onJump={jumpToMessage} />}
          {tab === "rules" && <RulesPanel rules={s.rules} questions={s.questions} />}
          {tab === "versions" && <Versions history={s.history} />}
          {tab === "glm" && <GlmLog items={s.glm} />}
          {tab === "state" && <pre className="state">{s.snapshot ? JSON.stringify(s.snapshot, null, 1) : "no snapshot yet"}</pre>}
        </section>
      </main>
      <Toasts toasts={s.toasts} onDismiss={s.dismissToast} onOpen={openHighlight} />
    </div>
  );
}
