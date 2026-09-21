import type { Highlight, JevAnswer, PollState, SessionSummary, StreamStatusEvent } from "@shared/protocol";
import { PollView } from "../components/Poll";
import type { SocialEvent } from "../lib/store";
import { duration, money, when } from "../lib/format";
import { Avatar, Spark, ago } from "../components/ui";
import { useT } from "../i18n";
import { Card, Count, Meter, RuleCard, StatTile, type CardActions } from "./widgets";
import { LIKES_LEVEL, VELOCITY_LEVEL, cardBody, fmtElapsed, type Audience, type DirectorPrefs, type RuleRow, type ViewerStats } from "./model";

const M = {
  en: {
    roomMeters: "room meters", queue: "prompt queue", focus: "focus", done: "done", feature: "feature", snooze: "snooze", nextPrev: "next / previous", upNext: "up next", upNextTitle: "Up next",
    dashboard: "dashboard", viewers: "viewers", noHistory: "no history yet", in5min: "{delta} in 5 min", peak: "peak {n}", chat: "chat", likes: "likes", gifts: "gifts", giftCount: "{n} gifts",
    newFollows: "new follows", sharesJoins: "{shares} shares · {joins} joins", onAir: "on air", noDecision: "no decision yet", lastDecision: "last decision {n} s ago",
    rules: "rules", rulesTitle: "Rules", firing: "{n} firing", noRules: "No rules yet. Add one in the console (key 2).",
    events: "events", eventsTitle: "Events", noEvents: "Gifts, follows and joins land here.", followed: "followed", shared: "shared", joined: "joined",
    overlay: "overlay", exitOverlay: "exit overlay", backToStage: "back to the stage (esc)", exitButton: "✕ Exit overlay", youSaid: "You said", onStage: "On stage", featureHint: "Feature a prompt (★ or f) to show it here.",
    recap: "session recap", streamEnded: "■ Stream ended", duration: "duration", peakViewers: "peak viewers", speechLines: "{n} lines of speech", prompts: "prompts", warnings: "{n} warnings", noWarnings: "no warnings",
    firedMost: "fired most", nothingFired: "nothing fired", spend: "spend", waitingNext: "Waiting for the next stream. The console reconnects on its own.",
  },
  fr: {
    roomMeters: "jauges de la salle", queue: "file des prompts", focus: "focus", done: "terminé", feature: "mettre en avant", snooze: "reporter", nextPrev: "suivant / précédent", upNext: "à suivre", upNextTitle: "À suivre",
    dashboard: "tableau de bord", viewers: "spectateurs", noHistory: "pas encore d'historique", in5min: "{delta} en 5 min", peak: "pic {n}", chat: "chat", likes: "likes", gifts: "cadeaux", giftCount: "{n} cadeaux",
    newFollows: "nouveaux abonnés", sharesJoins: "{shares} partages · {joins} arrivées", onAir: "à l'antenne", noDecision: "pas encore de décision", lastDecision: "dernière décision il y a {n} s",
    rules: "règles", rulesTitle: "Règles", firing: "{n} en alerte", noRules: "Pas encore de règle. Ajoute-en une dans la console (touche 2).",
    events: "événements", eventsTitle: "Événements", noEvents: "Les cadeaux, abonnements et arrivées s'affichent ici.", followed: "s'est abonné", shared: "a partagé", joined: "est arrivé",
    overlay: "overlay", exitOverlay: "quitter l'overlay", backToStage: "retour à la scène (échap)", exitButton: "✕ Quitter l'overlay", youSaid: "Tu as dit", onStage: "Sur scène", featureHint: "Mets un prompt en avant (★ ou f) pour l'afficher ici.",
    recap: "bilan de la session", streamEnded: "■ Live terminé", duration: "durée", peakViewers: "pic de spectateurs", speechLines: "{n} lignes de parole", prompts: "prompts", warnings: "{n} avertissements", noWarnings: "aucun avertissement",
    firedMost: "la plus déclenchée", nothingFired: "rien de déclenché", spend: "dépense", waitingNext: "En attente du prochain live. La console se reconnecte toute seule.",
  },
};

export interface MeterData { id: string; label: string; answer?: JevAnswer; fired: boolean; skipped: boolean; history: number[] }
export interface TickerLine { id: string; handle: string; name: string; text: string; hot: boolean; avatar?: string }
export interface Stats { elapsedMs: number | null; viewers: ViewerStats; viewerSeries: number[]; velocity: string; likes: string; audience: Audience; decisionAgeSec: number | null; latencyMs: number | null }
export interface ViewData {
  cards: { item: Highlight; leaving: boolean }[]; queueLength: number; meters: MeterData[]; rules: RuleRow[]; stats: Stats; chat: TickerLine[]; events: SocialEvent[];
  /** avatars seen in chat, by handle, for events that carry none */ avatars: Map<string, string>;
  poll: PollState | null; onStartPoll: () => void;
  now: number; prefs: DirectorPrefs; selectedId: string | null; live: boolean;
  /** what to say on an empty stage */ idle: { title: string; detail: string };
}

const Idle = ({ idle }: { idle: ViewData["idle"] }) => <div className="d-idle"><span>{idle.title}</span><small>{idle.detail}</small></div>;
const Meters = ({ meters }: { meters: MeterData[] }) => {
  const t = useT(M);
  return meters.length ? <section className="d-meters" aria-label={t("roomMeters")}>{meters.map((m) => <Meter key={m.id} label={m.label} answer={m.answer} fired={m.fired} skipped={m.skipped} history={m.history} />)}</section> : null;
};

/** Stage: meters on top, the queue below. */
export function StageView({ data, actions }: { data: ViewData; actions: CardActions }) {
  const t = useT(M);
  return (
    <>
      {data.prefs.showMeters && <Meters meters={data.meters} />}
      {data.poll && <PollView poll={data.poll} size="big" controls onStart={data.onStartPoll} />}
      <section className="d-cards" aria-live="polite" aria-label={t("queue")}>
        {data.cards.map(({ item, leaving }) => <Card key={item.id} h={item} now={data.now} ttlSec={data.prefs.ttlSec} selected={item.id === data.selectedId} leaving={leaving} actions={actions} />)}
        {data.cards.length === 0 && <Idle idle={data.idle} />}
      </section>
    </>
  );
}

/** Focus: the selected prompt at teleprompter size, the rest of the queue as a side list. */
export function FocusView({ data, actions }: { data: ViewData; actions: CardActions }) {
  const t = useT(M);
  const current = data.cards.find((c) => !c.leaving && c.item.id === data.selectedId) ?? data.cards.find((c) => !c.leaving);
  const rest = data.cards.filter((c) => !c.leaving && c.item.id !== current?.item.id);
  const index = current ? data.cards.filter((c) => !c.leaving).findIndex((c) => c.item.id === current.item.id) + 1 : 0;
  return (
    <section className="d-focus" aria-label={t("focus")}>
      <div className="d-focus-main">
        {current ? <Card h={current.item} now={data.now} ttlSec={data.prefs.ttlSec} selected size="big" actions={actions} /> : <Idle idle={data.idle} />}
        {current && <div className="d-focus-hint"><span className="d-focus-pos">{index} / {data.queueLength}</span><span><kbd>↵</kbd> {t("done")}</span><span><kbd>f</kbd> {t("feature")}</span><span><kbd>z</kbd> {t("snooze")}</span><span><kbd>↓</kbd><kbd>↑</kbd> {t("nextPrev")}</span></div>}
      </div>
      {rest.length > 0 && (
        <aside className="d-next" aria-label={t("upNext")}>
          <h4>{t("upNextTitle")} <span>{rest.length}</span></h4>
          {rest.map(({ item }) => <Card key={item.id} h={item} now={data.now} ttlSec={data.prefs.ttlSec} size="small" actions={actions} />)}
        </aside>
      )}
    </section>
  );
}

/** Dashboard: the audience at a glance, then meters, queue and the social feed. */
export function DashboardView({ data, actions }: { data: ViewData; actions: CardActions }) {
  const t = useT(M);
  const s = data.stats;
  const trendGlyph = s.viewers.trend === "up" ? "↗" : s.viewers.trend === "down" ? "↘" : "→";
  const eventLine = (e: SocialEvent) => e.kind === "gift" ? `🎁 ${e.handle} · ${e.giftName}${e.count > 1 ? ` ×${e.count}` : ""} · 💎 ${e.diamonds * e.count}` : e.kind === "social" ? `${e.action === "follow" ? "➕" : e.action === "share" ? "🔁" : "✦"} ${e.handle} ${e.action === "follow" ? t("followed") : e.action === "share" ? t("shared") : ""}` : `👋 ${e.nickname || e.handle} ${t("joined")}`;
  return (
    <section className="d-dash" aria-label={t("dashboard")}>
      <div className="d-tiles">
        <StatTile icon="👁" label={t("viewers")} value={s.viewers.current === null ? "–" : <Count value={s.viewers.current} />} sub={<>{trendGlyph} {s.viewers.delta === null ? t("noHistory") : t("in5min", { delta: `${s.viewers.delta >= 0 ? "+" : ""}${s.viewers.delta}` })} · {t("peak", { n: s.viewers.peak })}</>} tone={s.viewers.trend === "flat" ? undefined : s.viewers.trend} spark={s.viewerSeries} big />
        <StatTile icon="💬" label={t("chat")} text value={<span className="cap">{s.velocity}</span>} sub={<span className="d-level"><i style={{ width: `${(VELOCITY_LEVEL[s.velocity] ?? 0) * 100}%` }} /></span>} tone={s.velocity === "flood" ? "hot" : undefined} />
        <StatTile icon="❤️" label={t("likes")} text value={<span className="cap">{s.likes}</span>} sub={<span className="d-level"><i style={{ width: `${(LIKES_LEVEL[s.likes] ?? 0) * 100}%` }} /></span>} tone={s.likes === "burst" ? "hot" : undefined} />
        <StatTile icon="💎" label={t("gifts")} value={<Count value={s.audience.diamonds} />} sub={s.audience.leaders.length ? s.audience.leaders.map((l) => `${l.handle} ${l.diamonds}`).join(" · ") : t("giftCount", { n: s.audience.gifts })} tone={s.audience.diamonds > 0 ? "hot" : undefined} />
        <StatTile icon="➕" label={t("newFollows")} value={<Count value={s.audience.follows} />} sub={t("sharesJoins", { shares: s.audience.shares, joins: s.audience.joins })} />
        <StatTile icon="⏱" label={t("onAir")} value={s.elapsedMs === null ? "–" : fmtElapsed(s.elapsedMs)} sub={s.decisionAgeSec === null ? t("noDecision") : `${t("lastDecision", { n: s.decisionAgeSec })}${s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ""}`} tone={s.decisionAgeSec !== null && s.decisionAgeSec > 10 ? "warn" : undefined} />
      </div>
      {data.poll && <PollView poll={data.poll} size="big" controls onStart={data.onStartPoll} />}
      <section className="d-rules" aria-label={t("rules")}>
        <h4>{t("rulesTitle")} <span>{data.rules.length}</span>{data.rules.some((r) => r.fired) && <em className="d-rules-live">{t("firing", { n: data.rules.filter((r) => r.fired).length })}</em>}</h4>
        {data.rules.length === 0 && <p className="d-notes-empty">{t("noRules")}</p>}
        {data.rules.map((r) => <RuleCard key={r.id} r={r} now={data.now} />)}
      </section>
      <div className="d-dash-cols">
        <section className="d-cards compact" aria-label={t("queue")}>
          {data.cards.map(({ item, leaving }) => <Card key={item.id} h={item} now={data.now} ttlSec={data.prefs.ttlSec} selected={item.id === data.selectedId} leaving={leaving} actions={actions} />)}
          {data.cards.length === 0 && <Idle idle={data.idle} />}
        </section>
        <section className="d-events" aria-label={t("events")}>
          <h4>{t("eventsTitle")}</h4>
          {data.events.length === 0 && <p className="d-notes-empty">{t("noEvents")}</p>}
          {[...data.events].reverse().slice(0, 14).map((e, i) => (
            <p key={`${e.ts}-${i}`} className={`d-ev ${e.kind}`}>
              <Avatar src={e.avatar ?? data.avatars.get(e.handle)} name={e.nickname || e.handle} handle={e.handle} size={20} className="d-ev-avatar" />
              {eventLine(e)}
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
  const t = useT(M);
  const featured = data.cards.find((c) => !c.leaving && c.item.pinned && c.item.severity !== "warn");
  return (
    <section className="d-overlay" aria-label={t("overlay")}>
      {data.poll && <PollView poll={data.poll} size="overlay" />}
      {onExit && <button className="d-exit" onClick={onExit} aria-label={t("exitOverlay")} title={t("backToStage")}>{t("exitButton")}</button>}
      {featured && (
        <div className="d-lt" key={featured.item.id}>
          {featured.item.message && <Avatar src={featured.item.message.avatar} name={featured.item.message.nickname || featured.item.message.handle} handle={featured.item.message.handle} size={54} className="d-lt-avatar" />}
          <div className="d-lt-body">
            <span className="d-lt-name">{featured.item.message ? featured.item.message.nickname || featured.item.message.handle : featured.item.kind === "transcript" ? t("youSaid") : t("onStage")}</span>
            <span className="d-lt-text">{cardBody(featured.item)}</span>
          </div>
        </div>
      )}
      {!featured && data.live && <div className="d-overlay-hint">{t("featureHint")}</div>}
    </section>
  );
}

/** After the stream: what the session looked like, until the next one starts. */
export function RecapView({ summary, status, chart }: { summary: SessionSummary; status: StreamStatusEvent | null; chart: number[] }) {
  const t = useT(M);
  const secs = Math.round((summary.endedAt - summary.startedAt) / 1000);
  return (
    <section className="d-recap" aria-label={t("recap")}>
      <header><span className="d-recap-tag">{t("streamEnded")}</span><b>@{summary.username}</b>{summary.title && <span className="d-recap-title">{summary.title}</span>}<span className="grow" /><span className="d-recap-when">{when(summary.endedAt)} · {summary.reason}</span></header>
      <div className="d-tiles">
        <StatTile icon="⏱" label={t("duration")} value={duration(secs)} big spark={chart} />
        <StatTile icon="👁" label={t("peakViewers")} value={summary.peakViewers} />
        <StatTile icon="💬" label={t("chat")} value={summary.chatCount} sub={t("speechLines", { n: summary.transcriptCount })} />
        <StatTile icon="⚑" label={t("prompts")} value={summary.highlights} sub={summary.warnings ? t("warnings", { n: summary.warnings }) : t("noWarnings")} tone={summary.warnings ? "warn" : undefined} />
        <StatTile icon="◎" label={t("firedMost")} text value={summary.topFired[0]?.label ?? "—"} sub={summary.topFired.slice(0, 3).map((x) => `${x.label} ×${x.count}`).join(" · ") || t("nothingFired")} />
        <StatTile icon="$" label={t("spend")} value={money(summary.spend)} />
      </div>
      <p className="d-recap-foot">{status?.detail ?? t("waitingNext")}</p>
      {chart.length > 1 && <Spark values={chart} max={Math.max(1, ...chart)} h={40} stretch className="d-recap-spark" />}
    </section>
  );
}
