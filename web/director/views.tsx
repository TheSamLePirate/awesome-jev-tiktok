import type { Highlight, JevAnswer, SessionSummary, StreamStatusEvent } from "@shared/protocol";
import type { SocialEvent } from "../lib/store";
import { duration, money, when } from "../lib/format";
import { Avatar, Spark, ago } from "../components/ui";
import { Card, Count, Meter, RuleCard, StatTile, type CardActions } from "./widgets";
import { LIKES_LEVEL, VELOCITY_LEVEL, cardBody, fmtElapsed, type Audience, type DirectorPrefs, type RuleRow, type ViewerStats } from "./model";

export interface MeterData { id: string; label: string; answer?: JevAnswer; fired: boolean; skipped: boolean; history: number[] }
export interface TickerLine { id: string; handle: string; name: string; text: string; hot: boolean; avatar?: string }
export interface Stats { elapsedMs: number | null; viewers: ViewerStats; viewerSeries: number[]; velocity: string; likes: string; audience: Audience; decisionAgeSec: number | null; latencyMs: number | null }
export interface ViewData {
  cards: { item: Highlight; leaving: boolean }[]; queueLength: number; meters: MeterData[]; rules: RuleRow[]; stats: Stats; chat: TickerLine[]; events: SocialEvent[];
  /** avatars seen in chat, by handle, for events that carry none */ avatars: Map<string, string>;
  now: number; prefs: DirectorPrefs; selectedId: string | null; live: boolean;
  /** what to say on an empty stage */ idle: { title: string; detail: string };
}

const Idle = ({ idle }: { idle: ViewData["idle"] }) => <div className="d-idle"><span>{idle.title}</span><small>{idle.detail}</small></div>;
const Meters = ({ meters }: { meters: MeterData[] }) => (meters.length ? <section className="d-meters" aria-label="room meters">{meters.map((m) => <Meter key={m.id} label={m.label} answer={m.answer} fired={m.fired} skipped={m.skipped} history={m.history} />)}</section> : null);

/** Stage: meters on top, the queue below. */
export function StageView({ data, actions }: { data: ViewData; actions: CardActions }) {
  return (
    <>
      {data.prefs.showMeters && <Meters meters={data.meters} />}
      <section className="d-cards" aria-live="polite" aria-label="prompt queue">
        {data.cards.map(({ item, leaving }) => <Card key={item.id} h={item} now={data.now} ttlSec={data.prefs.ttlSec} selected={item.id === data.selectedId} leaving={leaving} actions={actions} />)}
        {data.cards.length === 0 && <Idle idle={data.idle} />}
      </section>
    </>
  );
}

/** Focus: the selected prompt at teleprompter size, the rest of the queue as a side list. */
export function FocusView({ data, actions }: { data: ViewData; actions: CardActions }) {
  const current = data.cards.find((c) => !c.leaving && c.item.id === data.selectedId) ?? data.cards.find((c) => !c.leaving);
  const rest = data.cards.filter((c) => !c.leaving && c.item.id !== current?.item.id);
  const index = current ? data.cards.filter((c) => !c.leaving).findIndex((c) => c.item.id === current.item.id) + 1 : 0;
  return (
    <section className="d-focus" aria-label="focus">
      <div className="d-focus-main">
        {current ? <Card h={current.item} now={data.now} ttlSec={data.prefs.ttlSec} selected size="big" actions={actions} /> : <Idle idle={data.idle} />}
        {current && <div className="d-focus-hint"><span className="d-focus-pos">{index} / {data.queueLength}</span><span><kbd>↵</kbd> done</span><span><kbd>f</kbd> feature</span><span><kbd>z</kbd> snooze</span><span><kbd>↓</kbd><kbd>↑</kbd> next / previous</span></div>}
      </div>
      {rest.length > 0 && (
        <aside className="d-next" aria-label="up next">
          <h4>Up next <span>{rest.length}</span></h4>
          {rest.map(({ item }) => <Card key={item.id} h={item} now={data.now} ttlSec={data.prefs.ttlSec} size="small" actions={actions} />)}
        </aside>
      )}
    </section>
  );
}

/** Dashboard: the audience at a glance, then meters, queue and the social feed. */
export function DashboardView({ data, actions }: { data: ViewData; actions: CardActions }) {
  const s = data.stats;
  const trendGlyph = s.viewers.trend === "up" ? "↗" : s.viewers.trend === "down" ? "↘" : "→";
  return (
    <section className="d-dash" aria-label="dashboard">
      <div className="d-tiles">
        <StatTile icon="👁" label="viewers" value={s.viewers.current === null ? "–" : <Count value={s.viewers.current} />} sub={<>{trendGlyph} {s.viewers.delta === null ? "no history yet" : `${s.viewers.delta >= 0 ? "+" : ""}${s.viewers.delta} in 5 min`} · peak {s.viewers.peak}</>} tone={s.viewers.trend === "flat" ? undefined : s.viewers.trend} spark={s.viewerSeries} big />
        <StatTile icon="💬" label="chat" text value={<span className="cap">{s.velocity}</span>} sub={<span className="d-level"><i style={{ width: `${(VELOCITY_LEVEL[s.velocity] ?? 0) * 100}%` }} /></span>} tone={s.velocity === "flood" ? "hot" : undefined} />
        <StatTile icon="❤️" label="likes" text value={<span className="cap">{s.likes}</span>} sub={<span className="d-level"><i style={{ width: `${(LIKES_LEVEL[s.likes] ?? 0) * 100}%` }} /></span>} tone={s.likes === "burst" ? "hot" : undefined} />
        <StatTile icon="💎" label="gifts" value={<Count value={s.audience.diamonds} />} sub={s.audience.leaders.length ? s.audience.leaders.map((l) => `${l.handle} ${l.diamonds}`).join(" · ") : `${s.audience.gifts} gifts`} tone={s.audience.diamonds > 0 ? "hot" : undefined} />
        <StatTile icon="➕" label="new follows" value={<Count value={s.audience.follows} />} sub={`${s.audience.shares} shares · ${s.audience.joins} joins`} />
        <StatTile icon="⏱" label="on air" value={s.elapsedMs === null ? "–" : fmtElapsed(s.elapsedMs)} sub={s.decisionAgeSec === null ? "no decision yet" : `last decision ${s.decisionAgeSec} s ago${s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ""}`} tone={s.decisionAgeSec !== null && s.decisionAgeSec > 10 ? "warn" : undefined} />
      </div>
      <section className="d-rules" aria-label="rules">
        <h4>Rules <span>{data.rules.length}</span>{data.rules.some((r) => r.fired) && <em className="d-rules-live">{data.rules.filter((r) => r.fired).length} firing</em>}</h4>
        {data.rules.length === 0 && <p className="d-notes-empty">No rules yet. Add one in the console (key 2).</p>}
        {data.rules.map((r) => <RuleCard key={r.id} r={r} now={data.now} />)}
      </section>
      <div className="d-dash-cols">
        <section className="d-cards compact" aria-label="prompt queue">
          {data.cards.map(({ item, leaving }) => <Card key={item.id} h={item} now={data.now} ttlSec={data.prefs.ttlSec} selected={item.id === data.selectedId} leaving={leaving} actions={actions} />)}
          {data.cards.length === 0 && <Idle idle={data.idle} />}
        </section>
        <section className="d-events" aria-label="events">
          <h4>Events</h4>
          {data.events.length === 0 && <p className="d-notes-empty">Gifts, follows and joins land here.</p>}
          {[...data.events].reverse().slice(0, 14).map((e, i) => (
            <p key={`${e.ts}-${i}`} className={`d-ev ${e.kind}`}>
              <Avatar src={e.avatar ?? data.avatars.get(e.handle)} name={e.nickname || e.handle} handle={e.handle} size={20} className="d-ev-avatar" />
              {e.kind === "gift" ? `🎁 ${e.handle} · ${e.giftName}${e.count > 1 ? ` ×${e.count}` : ""} · 💎 ${e.diamonds * e.count}` : e.kind === "social" ? `${e.action === "follow" ? "➕" : e.action === "share" ? "🔁" : "✦"} ${e.handle} ${e.action === "follow" ? "followed" : e.action === "share" ? "shared" : ""}` : `👋 ${e.nickname || e.handle} joined`}
              <small>{ago(e.ts, data.now)}</small>
            </p>
          ))}
        </section>
      </div>
    </section>
  );
}

/** Overlay (OBS): only what viewers may see, the featured prompt as a lower third. */
export function OverlayView({ data, onExit }: { data: ViewData; /** absent when the layout comes from the URL (an OBS source cannot leave it) */ onExit?: () => void }) {
  const featured = data.cards.find((c) => !c.leaving && c.item.pinned && c.item.severity !== "warn");
  return (
    <section className="d-overlay" aria-label="overlay">
      {onExit && <button className="d-exit" onClick={onExit} aria-label="exit overlay" title="back to the stage (esc)">✕ Exit overlay</button>}
      {featured && (
        <div className="d-lt" key={featured.item.id}>
          {featured.item.message && <Avatar src={featured.item.message.avatar} name={featured.item.message.nickname || featured.item.message.handle} handle={featured.item.message.handle} size={54} className="d-lt-avatar" />}
          <div className="d-lt-body">
            <span className="d-lt-name">{featured.item.message ? featured.item.message.nickname || featured.item.message.handle : featured.item.kind === "transcript" ? "You said" : "On stage"}</span>
            <span className="d-lt-text">{cardBody(featured.item)}</span>
          </div>
        </div>
      )}
      {!featured && data.live && <div className="d-overlay-hint">Feature a prompt (★ or f) to show it here.</div>}
    </section>
  );
}

/** After the stream: what the session looked like, until the next one starts. */
export function RecapView({ summary, status, chart }: { summary: SessionSummary; status: StreamStatusEvent | null; chart: number[] }) {
  const secs = Math.round((summary.endedAt - summary.startedAt) / 1000);
  return (
    <section className="d-recap" aria-label="session recap">
      <header><span className="d-recap-tag">■ Stream ended</span><b>@{summary.username}</b>{summary.title && <span className="d-recap-title">{summary.title}</span>}<span className="grow" /><span className="d-recap-when">{when(summary.endedAt)} · {summary.reason}</span></header>
      <div className="d-tiles">
        <StatTile icon="⏱" label="duration" value={duration(secs)} big spark={chart} />
        <StatTile icon="👁" label="peak viewers" value={summary.peakViewers} />
        <StatTile icon="💬" label="chat" value={summary.chatCount} sub={`${summary.transcriptCount} lines of speech`} />
        <StatTile icon="⚑" label="prompts" value={summary.highlights} sub={summary.warnings ? `${summary.warnings} warnings` : "no warnings"} tone={summary.warnings ? "warn" : undefined} />
        <StatTile icon="◎" label="fired most" text value={summary.topFired[0]?.label ?? "—"} sub={summary.topFired.slice(0, 3).map((t) => `${t.label} ×${t.count}`).join(" · ") || "nothing fired"} />
        <StatTile icon="$" label="spend" value={money(summary.spend)} />
      </div>
      <p className="d-recap-foot">{status?.detail ?? "Waiting for the next stream. The console reconnects on its own."}</p>
      {chart.length > 1 && <Spark values={chart} max={Math.max(1, ...chart)} h={40} stretch className="d-recap-spark" />}
    </section>
  );
}
