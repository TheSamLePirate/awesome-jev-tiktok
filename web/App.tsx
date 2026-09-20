import { useEffect, useState } from "react";
import { api, useSocket } from "./useSocket";
import { VideoPane } from "./components/VideoPane";
import { Gauges } from "./components/Gauges";
import { ChatFeed } from "./components/ChatFeed";
import { Transcript } from "./components/Transcript";
import { RulesPanel } from "./components/RulesPanel";
import { Versions } from "./components/Versions";
import { GlmLog } from "./components/GlmLog";
import { Alerts } from "./components/Alerts";

type Tab = "rules" | "alerts" | "versions" | "glm" | "state";

export function App() {
  const s = useSocket();
  const [username, setUsername] = useState("");
  const [tab, setTab] = useState<Tab>("rules");
  const [recordings, setRecordings] = useState<string[]>([]);
  useEffect(() => { if (s.status?.username && !username) setUsername(s.status.username); }, [s.status?.username]);
  useEffect(() => { void api.recordings().then(setRecordings).catch(() => {}); }, [s.status?.state]);

  const windowQs = s.questions?.questions.filter((q) => q.scope === "window") ?? [];
  const messageQs = s.questions?.questions.filter((q) => q.scope === "message") ?? [];
  const allQs = s.questions?.questions ?? [];
  const last = s.decisions.at(-1);
  const live = s.status?.state === "live";
  const glmBusy = s.glm.some((g) => g.status === "running");
  const firedNow = last?.fired.length ?? 0;

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
          <span className={`dot ${s.connected ? "live" : "offline"}`} title="ui socket" />
        </div>
      </header>

      <main>
        <section className="col left">
          <VideoPane url={s.hlsUrl} />
          <Transcript lines={s.transcript} interim={s.interim} captions={s.captions} />
        </section>

        <section className="col mid">
          <div className="section-head"><h2>Room</h2><span className="muted">{windowQs.length} questions · every second · {firedNow ? <b className="hot">{firedNow} firing</b> : "quiet"}</span></div>
          <div className="gauges-scroll"><Gauges questions={windowQs} decisions={s.decisions} snapshot={s.snapshot} /></div>
          <div className="section-head"><h2>Chat</h2><span className="muted">{messageQs.length ? `each message judged on ${messageQs.map((q) => q.label).join(", ")}` : "no per-message rules"}</span></div>
          <ChatFeed chat={s.chat} decisions={s.messageDecisions} questions={messageQs} />
        </section>

        <section className="col right">
          <nav className="tabs">
            {(["rules", "alerts", "versions", "glm", "state"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t}{t === "glm" && glmBusy ? <span className="pip" /> : null}{t === "alerts" && s.alerts.length ? <span className="count">{s.alerts.length}</span> : null}
              </button>
            ))}
          </nav>
          {tab === "rules" && <RulesPanel rules={s.rules} questions={s.questions} />}
          {tab === "alerts" && <Alerts alerts={s.alerts} questions={allQs} />}
          {tab === "versions" && <Versions history={s.history} />}
          {tab === "glm" && <GlmLog items={s.glm} />}
          {tab === "state" && <pre className="state">{s.snapshot ? JSON.stringify(s.snapshot, null, 1) : "no snapshot yet"}</pre>}
        </section>
      </main>
    </div>
  );
}
