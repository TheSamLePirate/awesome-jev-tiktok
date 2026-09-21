import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, MomentContext, RecordingInfo, SessionTimeline } from "@shared/protocol";
import { api, onApiError } from "./lib/api";
import { dismissToast, dispatch, getState, markSeen, toast, useStore, shallowEq } from "./lib/store";
import { usePref } from "./lib/prefs";
import { useHotkeys, type Hotkey } from "./lib/hotkeys";
import { chime, primeAudio } from "./lib/audio";
import { notifyIfHidden } from "./lib/notify";
import { VideoPane } from "./components/VideoPane";
import { Gauges } from "./components/Gauges";
import { ChatFeed } from "./components/ChatFeed";
import { Transcript, ScenePanel } from "./components/Transcript";
import { RulesPanel } from "./components/RulesPanel";
import { Versions } from "./components/Versions";
import { GlmLog } from "./components/GlmLog";
import { ActivityLog } from "./components/ActivityLog";
import { SettingsPanel, hasUnsavedSettings } from "./components/Settings";
import { Recordings } from "./components/Recordings";
import { Timeline, ReviewStrip } from "./components/Timeline";
import { Flagged } from "./components/Flagged";
import { Toasts } from "./components/Toasts";
import { EventsFeed } from "./components/EventsFeed";
import { HealthBar } from "./components/HealthBar";
import { SessionSummary } from "./components/SessionSummary";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DialogHost, confirm } from "./components/Dialog";
import { Kbd, Spark, useNow } from "./components/ui";
import { Login } from "./components/Login";
import { money } from "./lib/format";
import { fill, locale, tr, useLang, useT, type Vars } from "./i18n";
import { COMMON } from "./i18n/common";

const M = {
  en: {
    tab_flagged: "flagged", tab_rules: "rules", tab_versions: "versions", tab_glm: "GLM", tab_log: "log", tab_replays: "replays", tab_state: "state", tab_settings: "settings",
    connection: "stream connection", username: "tiktok username", disconnect: "Disconnect", connecting: "Connecting", connect: "Connect",
    watchHint: "watch this account: connect on its own as soon as it goes live, and reconnect if the stream drops", watchLabel: "connect when live",
    watching: "watching @{u}: reconnects if the stream drops or the server restarts", checking: "checking whether @{u} is live", lastCheck: " · last check {n} s ago",
    autoReconnect: "auto-reconnect", waiting: "waiting for @{u}", nextCheck: "next check in {n} s", stopWatching: "stop watching", stopWatchingHint: "stop watching this account",
    replayLabel: "replay a recording", replayHint: "replay a recorded session (🎥 = video available)", replayPick: "replay…", min: " · {n} min", mb: " · {n} MB",
    metrics: "live metrics", cachedHint: "last tick reused the previous answers (state unchanged)", latencyHint: "jev round trip, last 40 ticks", cached: "cached",
    spendHint: "model spend this session (server total)", spendEstimated: ", incl. {m} estimated (Deepgram)", spendCap: " · cap ${cap}", spend: "spend",
    questionsHint: "question set version · count", questions: "questions", viewers: "viewers", velocity: "chat velocity", glmHint: "GLM prompt writer", writing: "writing", idle: "idle",
    directorHint: "open the director view for the host (d)", director: "director", chimeHint: "alert chime {state} (s)", chime: "alert chime", shortcutsHint: "keyboard shortcuts (?)", shortcuts: "keyboard shortcuts",
    connected: "connected to server", unreachable: "server unreachable", noSnapshot: "no snapshot yet",
    slowDown: "Slow down", stopRecTitle: "Stop recording?", stopRecBody: "The segment is closed and finalized into a seekable MP4. You can start a new one later.", stopRec: "Stop",
    hkEsc: "close dialogs and the help sheet", hkPanel: "panel {tab}", hkRec: "start / stop video recording", hkSettings: "settings", hkDirector: "open the director view", hkSearch: "search flagged", hkMute: "mute / unmute stream", hkVideo: "video player: compact / large", hkChime: "alert chime on / off", hkHelp: "this help",
    lost: "Connection to the server lost. Reconnecting…", updated: "The server was updated. ", reloadConsole: "Reload the console",
    stream: "stream", decisions: "decisions", control: "control", panels: "panels",
    room: "Room", roomEvery: "{n} questions · every {s} s", roomEverySecond: "{n} questions · every second", firing: "{n} firing", quiet: "quiet",
    chat: "Chat", judgedOn: "each message judged on {list}", noMessageRules: "no per-message rules", settingsTab: "settings (,)",
    sessionEnded: "Your session ended or the server's token changed. Sign in again.",
    keyboard: "Keyboard", switchPanel: "switch panel", searchSession: "search the session (live or replay)", seek: "seek 10 s (when the timeline has focus)", backToLive: "back to live", addRule: "add rule from the composer", close: "close", never: "Shortcuts never fire while typing or with ⌘ / Ctrl / Alt held.",
  },
  fr: {
    tab_flagged: "signalés", tab_rules: "règles", tab_versions: "versions", tab_glm: "GLM", tab_log: "journal", tab_replays: "relectures", tab_state: "état", tab_settings: "réglages",
    connection: "connexion au stream", username: "pseudo tiktok", disconnect: "Déconnecter", connecting: "Connexion", connect: "Connecter",
    watchHint: "surveiller ce compte : se connecte tout seul dès qu'il passe en direct, et se reconnecte si le stream coupe", watchLabel: "connecter au passage en direct",
    watching: "surveille @{u} : se reconnecte si le stream coupe ou si le serveur redémarre", checking: "vérifie si @{u} est en direct", lastCheck: " · dernière vérification il y a {n} s",
    autoReconnect: "reconnexion auto", waiting: "en attente de @{u}", nextCheck: "prochaine vérification dans {n} s", stopWatching: "arrêter la surveillance", stopWatchingHint: "ne plus surveiller ce compte",
    replayLabel: "relire un enregistrement", replayHint: "relire une session enregistrée (🎥 = vidéo disponible)", replayPick: "relecture…", min: " · {n} min", mb: " · {n} Mo",
    metrics: "métriques en direct", cachedHint: "le dernier tick a réutilisé les réponses précédentes (état inchangé)", latencyHint: "aller-retour jev, 40 derniers ticks", cached: "en cache",
    spendHint: "dépense modèle cette session (total serveur)", spendEstimated: ", dont {m} estimés (Deepgram)", spendCap: " · plafond ${cap}", spend: "dépense",
    questionsHint: "version du jeu de questions · nombre", questions: "questions", viewers: "spectateurs", velocity: "rythme du chat", glmHint: "GLM, rédacteur des prompts", writing: "rédige", idle: "au repos",
    directorHint: "ouvrir la vue réalisateur pour l'hôte (d)", director: "réalisateur", chimeHint: "carillon d'alerte {state} (s)", chime: "carillon d'alerte", shortcutsHint: "raccourcis clavier (?)", shortcuts: "raccourcis clavier",
    connected: "connecté au serveur", unreachable: "serveur injoignable", noSnapshot: "pas encore d'instantané",
    slowDown: "Doucement", stopRecTitle: "Arrêter l'enregistrement ?", stopRecBody: "Le segment est fermé et finalisé en MP4 navigable. Tu pourras en démarrer un autre plus tard.", stopRec: "Arrêter",
    hkEsc: "fermer les dialogues et l'aide", hkPanel: "panneau {tab}", hkRec: "démarrer / arrêter l'enregistrement vidéo", hkSettings: "réglages", hkDirector: "ouvrir la vue réalisateur", hkSearch: "chercher dans les signalés", hkMute: "couper / rétablir le son du stream", hkVideo: "lecteur vidéo : compact / grand", hkChime: "carillon d'alerte activé / désactivé", hkHelp: "cette aide",
    lost: "Connexion au serveur perdue. Reconnexion…", updated: "Le serveur a été mis à jour. ", reloadConsole: "Recharger la console",
    stream: "stream", decisions: "décisions", control: "contrôle", panels: "panneaux",
    room: "Salle", roomEvery: "{n} questions · toutes les {s} s", roomEverySecond: "{n} questions · chaque seconde", firing: "{n} en alerte", quiet: "calme",
    chat: "Chat", judgedOn: "chaque message jugé sur {list}", noMessageRules: "aucune règle par message", settingsTab: "réglages (,)",
    sessionEnded: "Ta session a expiré ou le jeton du serveur a changé. Reconnecte-toi.",
    keyboard: "Clavier", switchPanel: "changer de panneau", searchSession: "chercher dans la session (direct ou relecture)", seek: "avancer / reculer de 10 s (quand la frise a le focus)", backToLive: "retour au direct", addRule: "ajouter la règle depuis le composeur", close: "fermer", never: "Les raccourcis ne se déclenchent jamais pendant la saisie ni avec ⌘ / Ctrl / Alt enfoncé.",
  },
};
/** Outside React (hotkeys, callbacks, the API error hook): reads the language when called. */
const tt = tr(M);

type Tab = "flagged" | "rules" | "versions" | "glm" | "log" | "replays" | "state" | "settings";
const TABS: Tab[] = ["flagged", "rules", "versions", "glm", "log", "replays", "state", "settings"];
/** Icon per panel (its name is `tab_<id>` in M): a narrow column shows the icon only (the active tab keeps its name), tooltips and 1‑8 do the rest. */
const TAB_ICON: Record<Tab, string> = { flagged: "⚑", rules: "✎", versions: "↺", glm: "✦", log: "≡", replays: "▶", state: "{}", settings: "⚙" };
type VideoSize = "compact" | "large";

/** Header: connection, KPIs, actions. Subscribes to small slices so a chat message never re-renders it. */
const Header = memo(function Header({ username, setUsername, sound, setSound, onHelp, onDirector }: { username: string; setUsername: (v: string) => void; sound: boolean; setSound: (v: boolean) => void; onHelp: () => void; onDirector: () => void }) {
  const t = useT(M), tc = useT(COMMON);
  const status = useStore((s) => s.status);
  const connected = useStore((s) => s.connected);
  const watch = useStore((s) => s.watch);
  const now = useNow(1000);
  const kpi = useStore((s) => ({ latency: s.decisions.at(-1)?.latencyMs, cached: s.decisions.at(-1)?.cached, spend: s.totals.session, estimated: s.totals.estimated, version: s.questions?.version, count: s.questions?.questions.length ?? 0, viewers: s.snapshot?.activity.viewers, velocity: s.snapshot?.activity.chat_velocity, glmBusy: s.glm.some((g) => g.status === "running"), budgetCap: s.health?.budget.cap ?? 0 }), shallowEq);
  const latencies = useStore((s) => s.decisions.slice(-40).map((d) => d.latencyMs).join(","));
  const viewersSeries = useStore((s) => s.viewers.slice(-40).map((v) => v.count).join(","));
  const lat = useMemo(() => latencies.split(",").filter(Boolean).map(Number), [latencies]);
  const vs = useMemo(() => viewersSeries.split(",").filter(Boolean).map(Number), [viewersSeries]);
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [connecting, setConnecting] = useState(false);
  const live = status?.state === "live";
  useEffect(() => { void api.recordings().then(setRecordings).catch(() => {}); }, [status?.state]);
  const connect = async (replayId?: string) => {
    setConnecting(true);
    try { await api.connect(replayId ? "replay" : username, replayId); } catch { /* toasted */ } finally { setConnecting(false); }
  };
  return (
    <header className="topbar">
      <div className="brand" title="tiktok:jev"><span className="logo" aria-hidden>◎</span><span className="brand-name">tiktok<span className="brand-sep">:</span>jev</span></div>
      <div className="conn" role="group" aria-label={t("connection")}>
        <span className={`status-pill ${status?.state ?? "offline"}`} title={status?.detail ?? status?.state}>
          <span className="dot" /><span className="status-state">{tc(connecting ? "connecting" : status?.state ?? "offline")}</span>{status?.title ? <span className="status-title">{status.title}</span> : null}
        </span>
        <form className="connect" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (!live && username && !connecting) void connect(); }}>
          <span className="at">@</span>
          <input name="tiktok-handle" value={username.replace(/^@/, "")} onChange={(e) => setUsername(e.target.value)} placeholder={t("username")} aria-label={t("username")} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" disabled={live || connecting} />
          {live ? <button type="button" onClick={() => api.disconnect().catch(() => {})}>{t("disconnect")}</button> : <button type="submit" className="primary" disabled={!username || connecting}>{connecting ? <><span className="spinner sm" /> {t("connecting")}</> : t("connect")}</button>}
          {!live && !watch?.armed && <button type="button" className="icon watch-btn" disabled={!username || connecting} onClick={() => api.watch(true, username).catch(() => {})} title={t("watchHint")} aria-label={t("watchLabel")}>👁</button>}
        </form>
        {watch?.armed && (
          <span className={`watch-pill ${live ? "on" : watch.lastResult === "error" ? "error" : ""}`} title={live ? t("watching", { u: watch.username }) : watch.detail ?? `${t("checking", { u: watch.username })}${watch.lastCheck ? t("lastCheck", { n: Math.max(0, Math.round((now - watch.lastCheck) / 1000)) }) : ""}`} role="status">
            <span aria-hidden>👁</span>
            <span className="watch-text">{live ? t("autoReconnect") : t("waiting", { u: watch.username })}{!live && watch.nextCheck !== null && <em> · {watch.detail ? watch.detail : t("nextCheck", { n: Math.max(0, Math.round((watch.nextCheck - now) / 1000)) })}</em>}</span>
            <button type="button" className="icon" onClick={() => api.watch(false).catch(() => {})} aria-label={t("stopWatching")} title={t("stopWatchingHint")}>✕</button>
          </span>
        )}
        {recordings.length > 0 && !live && (
          <select className="replay-picker" value="" onChange={(e) => { if (e.target.value) void connect(e.target.value); }} aria-label={t("replayLabel")} title={t("replayHint")} disabled={connecting}>
            <option value="">{t("replayPick")}</option>
            {recordings.map((r) => <option key={r.id} value={r.id}>{r.videos.length ? "🎥 " : "· "}{r.username} · {new Date(r.createdAt).toLocaleString(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{r.durationSec ? t("min", { n: Math.round(r.durationSec / 60) }) : ""}{r.sizeBytes ? t("mb", { n: (r.sizeBytes / 1e6).toFixed(0) }) : ""}</option>)}
          </select>
        )}
        {status?.state === "error" && <span className="conn-error" title={status.detail}>{status.detail}</span>}
      </div>
      <div className="kpis" aria-label={t("metrics")}>
        <div className="kpi" title={kpi.cached ? t("cachedHint") : t("latencyHint")}><small>jev</small><b>{kpi.latency !== undefined ? (kpi.cached ? t("cached") : kpi.latency) : "—"}{!kpi.cached && kpi.latency !== undefined && <i>ms</i>}</b><Spark values={lat} max={Math.max(600, ...lat)} w={56} h={16} /></div>
        <div className="kpi" title={`${t("spendHint")}${kpi.estimated ? t("spendEstimated", { m: money(kpi.estimated) }) : ""}${kpi.budgetCap ? t("spendCap", { cap: kpi.budgetCap.toFixed(2) }) : ""}`}><small>{t("spend")}</small><b>{money(kpi.spend)}{kpi.budgetCap ? <i>/ ${kpi.budgetCap.toFixed(0)}</i> : null}</b></div>
        <div className="kpi optional" title={t("questionsHint")}><small>{t("questions")}</small><b>v{kpi.version ?? "–"}<i>· {kpi.count}</i></b></div>
        <div className="kpi" title={t("viewers")}><small>{t("viewers")}</small><b>{kpi.viewers ?? "–"}</b><Spark values={vs} max={Math.max(1, ...vs)} w={56} h={16} /></div>
        <div className="kpi optional" title={t("velocity")}><small>{tc("chat")}</small><b className="cap">{kpi.velocity ?? "–"}</b></div>
        <div className={`kpi ${kpi.glmBusy ? "busy" : ""}`} title={t("glmHint")}><small>GLM</small><b>{kpi.glmBusy ? <><span className="spinner sm" /> {t("writing")}</> : t("idle")}</b></div>
      </div>
      <div className="actions">
        <button className="icon director-btn" title={t("directorHint")} onClick={onDirector}><span aria-hidden>🎬</span><span className="label">{t("director")}</span></button>
        <button className={`icon ${sound ? "on" : ""}`} title={t("chimeHint", { state: tc(sound ? "on" : "off") })} onClick={() => setSound(!sound)} aria-pressed={sound} aria-label={t("chime")}>{sound ? "🔔" : "🔕"}</button>
        <button className="icon" title={t("shortcutsHint")} onClick={onHelp} aria-label={t("shortcuts")}>?</button>
        <span className={`dot ${connected ? "live" : "offline"}`} title={t(connected ? "connected" : "unreachable")} role="img" aria-label={t(connected ? "connected" : "unreachable")} />
      </div>
    </header>
  );
});

const StatePanel = memo(function StatePanel() {
  const t = useT(M);
  const snapshot = useStore((s) => s.snapshot);
  return <pre className="state">{snapshot ? JSON.stringify(snapshot, null, 1) : t("noSnapshot")}</pre>;
});

export function App() {
  const t = useT(M);
  const lang = useLang();
  const [username, setUsername] = useState("");
  const [tab, setTab] = useState<Tab>("flagged");
  const [focusHighlight, setFocusHighlight] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const [sound, setSound] = usePref("jev.sound", false);
  const [muted, setMuted] = usePref("jev.muted", true);
  const [notify, setNotify] = usePref("jev.notify", false);
  const [mutedUsers] = usePref<string[]>("jev.mutedUsers", []);
  // Compact: a small 9:16 player beside the scene caption, so the host transcript gets the column. Large: the player centered at 44vh.
  const [videoSize, setVideoSize] = usePref<VideoSize>("jev.videoSize", "compact");
  const toggleVideoSize = useCallback(() => setVideoSize((v) => (v === "large" ? "compact" : "large")), [setVideoSize]);
  const [help, setHelp] = useState(false);
  /** Toast ids already chimed / notified: dismissing one must not re-announce the toast that becomes last again. */
  const seenToasts = useRef(new Set<string>());
  const now = useNow(1000);

  const status = useStore((s) => s.status);
  const connected = useStore((s) => s.connected);
  const protocolMismatch = useStore((s) => s.protocolMismatch);
  const replay = useStore((s) => s.replay);
  const video = useStore((s) => s.video);
  const recording = useStore((s) => s.recording);
  const highlights = useStore((s) => s.highlights);
  const unseenCount = useStore((s) => s.unseen.length);
  const openCount = useStore((s) => s.highlights.filter((h) => !h.resolved).length);
  const glmBusy = useStore((s) => s.glm.some((g) => g.status === "running"));
  const firedNow = useStore((s) => s.decisions.at(-1)?.fired.length ?? 0);
  const windowQs = useStore((s) => s.windowQs);
  const messageQs = useStore((s) => s.messageQs);
  const allQs = useStore((s) => s.questions?.questions ?? []);
  const questions = useStore((s) => s.questions);
  const rules = useStore((s) => s.rules);
  const pausedRuleIds = useMemo(() => new Set(rules.filter((r) => r.paused).map((r) => r.id)), [rules]);
  const decisions = useStore((s) => s.decisions);
  const snapshot = useStore((s) => s.snapshot);
  const chat = useStore((s) => s.chat);
  const messageDecisions = useStore((s) => s.messageDecisions);
  const transcript = useStore((s) => s.transcript);
  const interim = useStore((s) => s.interim);
  const captions = useStore((s) => s.captions);
  const social = useStore((s) => s.social);
  const history = useStore((s) => s.history);
  const glm = useStore((s) => s.glm);
  const log = useStore((s) => s.log);
  const totals = useStore((s) => s.totals);
  const settings = useStore((s) => s.settings);
  const health = useStore((s) => s.health);
  const summary = useStore((s) => s.summary);
  const lastToastItem = useStore((s) => s.toasts.at(-1));
  const unsureBelow = settings?.decisions.unsureBelow ?? 0.35;

  const live = status?.state === "live";
  const isReplay = !!replay;
  const booted = status !== null;

  // Time-shift: the live session's timeline, where playback sits, and the moment under review.
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null);
  const [reviewTs, setReviewTs] = useState<number | null>(null);
  const [review, setReview] = useState<MomentContext | null>(null);
  const [reviewQ, setReviewQ] = useState("");
  const [query, setQuery] = useState("");
  const [inDvr, setInDvr] = useState(true);
  const [playing, setPlaying] = useState<{ ts: number | null; behind: number }>({ ts: null, behind: 0 });
  useEffect(() => {
    if (!live || isReplay) { setTimeline(null); setReviewTs(null); setReview(null); return; }
    let stop = false;
    const tick = () => api.timeline().then((t) => { if (!stop) setTimeline(t); }).catch(() => {});
    void tick();
    const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [live, isReplay]);
  const onPlayingTs = useCallback((ts: number | null, behind: number) => setPlaying({ ts, behind }), []);
  const onSeekResult = useCallback((_ts: number, ok: boolean) => setInDvr(ok), []);
  // Every seek refreshes the review strip (debounced), so a click on the track never leaves a stale context.
  const ctxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seekTo = useCallback((ts: number) => {
    const rp = getState().replay;
    if (rp) { setReview(null); void api.seekReplay(Math.max(0, ts - rp.t0)).catch(() => {}); return; }
    setReviewTs(ts);
    clearTimeout(ctxTimer.current);
    ctxTimer.current = setTimeout(() => { void api.context(ts).then((c) => { setReview(c); setReviewQ(query); }).catch(() => {}); }, 250);
  }, [query]);
  // Also drops a context fetch still in its debounce, so a stale strip cannot reappear after the jump back.
  const backToLive = useCallback(() => { clearTimeout(ctxTimer.current); setReviewTs(null); setReview(null); setInDvr(true); }, []);
  const onReview = useCallback((ctx: MomentContext | null, q: string) => { setReview(ctx); setReviewQ(q); }, []);
  // "Watch this moment": DVR review on a live, a seek on a replay.
  const canWatch = live && !!video;

  // Adopt the server's streamer name once, but never a synthetic replay / simulation name.
  useEffect(() => { if (status?.username && !username && !["replay", "sim"].includes(status.username)) setUsername(status.username); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.username]);
  useEffect(() => { if (tab === "flagged") markSeen(); }, [tab, unseenCount]);
  useEffect(() => primeAudio(), []);
  const authRequired = useStore((s) => s.authRequired);
  useEffect(() => onApiError((e) => { if (e.status === 401) dispatch({ type: "auth", required: true, protected: true }); else if (e.status === 429) toast({ kind: "error", title: tt("slowDown"), body: e.message }); else toast({ kind: "error", title: e.message }); }), []);
  // Chime and browser notification for a fresh highlight, unless its author is muted in this console.
  useEffect(() => {
    const t = lastToastItem;
    if (!t || t.kind !== "highlight" || !t.highlight || seenToasts.current.has(t.id)) return;
    seenToasts.current.add(t.id);
    const h = t.highlight;
    if (h.message && mutedUsers.includes(h.message.userId)) { dismissToast(t.id); return; }
    if (sound) chime(h.severity);
    if (notify) notifyIfHidden(`${h.severity === "warn" ? "⚠ " : ""}${h.flags.map((f) => f.label).join(", ")}`, h.message ? `${h.message.nickname || h.message.handle}: ${h.message.text}` : h.transcript?.lines.map((l) => l.text).join(" ").slice(-120) ?? h.scene?.text ?? "", h.id);
  }, [lastToastItem, sound, notify, mutedUsers]);
  // Do not lose an unsaved settings draft on reload.
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (hasUnsavedSettings()) e.preventDefault(); }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, []);

  const openDirector = useCallback(() => window.open("/?view=director", "jev-director", "width=1280,height=720"), []);
  const toggleRecording = useCallback(async () => {
    const rec = getState().recording;
    if (rec.active) { if (!(await confirm({ title: tt("stopRecTitle"), body: tt("stopRecBody"), confirmLabel: tt("stopRec"), danger: true }))) return; await api.stopRecording().catch(() => {}); }
    else await api.startRecording().catch(() => {});
  }, []);
  const switchTab = useCallback((t: Tab) => setTab(t), []);

  // The help texts read `M[lang]` directly, so the map is rebuilt exactly once per language switch.
  const hotkeys = useMemo<Hotkey[]>(() => {
    const th = (k: keyof typeof M.en, vars?: Vars) => fill(M[lang][k], vars);
    return [
    { key: "Escape", label: "esc", help: th("hkEsc"), global: true, run: () => { setHelp(false); const el = document.activeElement as HTMLElement | null; if (el && el !== document.body && !el.closest("dialog")) el.blur(); } },
    ...TABS.map((t, i): Hotkey => ({ key: String(i + 1), label: String(i + 1), help: th("hkPanel", { tab: th(`tab_${t}`) }), run: () => switchTab(t) })),
    { key: "r", label: "r", help: th("hkRec"), when: () => live && !isReplay, run: () => void toggleRecording() },
    { key: ",", label: ",", help: th("hkSettings"), run: () => switchTab("settings") },
    { key: "d", label: "d", help: th("hkDirector"), run: openDirector },
    { key: "/", label: "/", help: th("hkSearch"), run: () => { switchTab("flagged"); setTimeout(() => document.getElementById("hl-search")?.focus(), 0); } },
    { key: "m", label: "m", help: th("hkMute"), run: () => setMuted((v) => !v) },
    { key: "v", label: "v", help: th("hkVideo"), run: toggleVideoSize },
    { key: "s", label: "s", help: th("hkChime"), run: () => setSound((v) => !v) },
    { key: "?", label: "?", help: th("hkHelp"), run: () => setHelp((v) => !v) },
    ];
  }, [live, isReplay, switchTab, toggleRecording, openDirector, setMuted, setSound, toggleVideoSize, lang]);
  useHotkeys(hotkeys);

  const openHighlight = useCallback((h: Highlight) => { setTab("flagged"); setFocusHighlight(h.id); dismissToast(`hl-${h.id}`); }, []);
  const jumpToMessage = useCallback((id: string) => setFocusMessage(id), []);
  const openMessageHighlight = useCallback((messageId: string) => {
    const h = [...getState().highlights].reverse().find((x) => x.message?.id === messageId);
    if (h) { setTab("flagged"); setFocusHighlight(h.id); }
  }, []);
  const onToggleMute = useCallback(() => setMuted((v) => !v), [setMuted]);
  const replaySummary = useCallback((id: string) => { void api.connect("replay", id).catch(() => {}); }, []);

  return (
    <div className={`app ${booted ? "" : "booting"} ${live && (replay || timeline) ? "replaying" : ""}`}>
      {!connected && booted && <div className="banner warn" role="status">{t("lost")}</div>}
      {protocolMismatch && <div className="banner warn" role="alert">{t("updated")}<button className="chip-btn" onClick={() => location.reload()}>{t("reloadConsole")}</button></div>}
      <Header username={username} setUsername={setUsername} sound={sound} setSound={setSound} onHelp={() => setHelp((v) => !v)} onDirector={openDirector} />
      <HealthBar health={health} live={live} now={now} />
      {live && (replay || timeline) && (
        <ErrorBoundary name="Timeline">
          <Timeline mode={replay ? { kind: "replay", replay } : { kind: "live", timeline: timeline!, playingTs: playing.ts, behindSec: playing.behind, reviewTs }} highlights={highlights} onSeek={seekTo} onLive={backToLive} onReview={onReview} query={query} onQuery={setQuery} />
        </ErrorBoundary>
      )}
      {live && review && <ReviewStrip ctx={review} q={reviewQ} live={!replay} inDvr={inDvr} onClose={() => setReview(null)} onLive={backToLive} />}

      <main>
        <section className="col left" aria-label={t("stream")}>
          <div className={`stream-top ${videoSize}`}>
            <ErrorBoundary name="Video">
              <VideoPane source={video} viewers={snapshot?.activity.viewers} title={status?.title} live={live} muted={muted} onToggleMute={onToggleMute} recording={recording} onRecord={toggleRecording} reviewTs={reviewTs} onPlayingTs={onPlayingTs} onSeekResult={onSeekResult} size={videoSize} onToggleSize={toggleVideoSize} />
            </ErrorBoundary>
            <ErrorBoundary name="Scene">
              <ScenePanel captions={captions} highlights={highlights} sources={snapshot?.sources} onOpen={openHighlight} />
            </ErrorBoundary>
          </div>
          <ErrorBoundary name="Transcript">
            <Transcript lines={transcript} interim={interim} highlights={highlights} sources={snapshot?.sources} onOpen={openHighlight} />
          </ErrorBoundary>
        </section>

        <section className="col mid" aria-label={t("decisions")}>
          {/* Room: meters and social events, capped to half the column (stacked) or a full-height side rail (wide). Chat takes the rest. */}
          <div className="room">
            {!live && summary && <ErrorBoundary name="Summary"><SessionSummary s={summary} highlights={highlights} onReplay={replaySummary} /></ErrorBoundary>}
            <div className="section-head"><h2>{t("room")}</h2><span className="muted">{settings ? t("roomEvery", { n: windowQs.length, s: settings.timing.tickMs / 1000 }) : t("roomEverySecond", { n: windowQs.length })}</span><span className="grow" />{firedNow ? <span className="firing-pill">{t("firing", { n: firedNow })}</span> : <span className="muted">{t("quiet")}</span>}</div>
            <div className="gauges-scroll"><ErrorBoundary name="Gauges"><Gauges questions={windowQs} decisions={decisions} pausedRuleIds={pausedRuleIds} unsureBelow={unsureBelow} live={live} /></ErrorBoundary></div>
            <ErrorBoundary name="Events"><EventsFeed events={social} /></ErrorBoundary>
          </div>
          <div className="chat-block">
            <div className="section-head"><h2>{t("chat")}</h2><span className="muted" title={messageQs.map((q) => q.label).join(", ")}>{messageQs.length ? t("judgedOn", { list: messageQs.map((q) => q.label).join(", ") }) : t("noMessageRules")}</span></div>
            <ErrorBoundary name="Chat"><ChatFeed chat={chat} decisions={messageDecisions} questions={messageQs} focusId={focusMessage} onOpenFlag={openMessageHighlight} /></ErrorBoundary>
          </div>
        </section>

        <section className="col right" aria-label={t("control")}>
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role */}
          <nav className="tabs" role="tablist" aria-label={t("panels")}>
            {TABS.map((id, i) => (
              <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} className={`${tab === id ? "active" : ""} ${id === "settings" ? "gear" : ""}`} onClick={() => setTab(id)} onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const j = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length; setTab(TABS[j]); document.getElementById(`tab-${TABS[j]}`)?.focus(); } }} title={id === "settings" ? t("settingsTab") : `${t(`tab_${id}`)} (${i + 1})`} aria-label={id}>
                <span className="tab-icon" aria-hidden>{TAB_ICON[id]}</span>
                {id !== "settings" && <span className="tab-label">{t(`tab_${id}`)}</span>}
                {id === "flagged" && openCount ? <span className={`count ${unseenCount ? "new" : ""}`}>{openCount}</span> : null}
                {id === "glm" && glmBusy ? <span className="pip" /> : null}
              </button>
            ))}
          </nav>
          {/* Panels stay mounted so drafts, filters and selections survive a tab switch; hidden ones pause their polling. */}
          <div className="tab-body">
            <div role="tabpanel" id="panel-flagged" aria-labelledby="tab-flagged" hidden={tab !== "flagged"} className="tab-pane"><ErrorBoundary name="Flagged"><Flagged highlights={highlights} questions={allQs} focusId={focusHighlight} onJump={jumpToMessage} onWatch={seekTo} canWatch={canWatch} /></ErrorBoundary></div>
            <div role="tabpanel" id="panel-rules" aria-labelledby="tab-rules" hidden={tab !== "rules"} className="tab-pane"><ErrorBoundary name="Rules"><RulesPanel rules={rules} questions={questions} compiling={glmBusy} /></ErrorBoundary></div>
            <div role="tabpanel" id="panel-versions" aria-labelledby="tab-versions" hidden={tab !== "versions"} className="tab-pane"><ErrorBoundary name="Versions"><Versions history={history} /></ErrorBoundary></div>
            <div role="tabpanel" id="panel-glm" aria-labelledby="tab-glm" hidden={tab !== "glm"} className="tab-pane"><ErrorBoundary name="GLM"><GlmLog items={glm} /></ErrorBoundary></div>
            <div role="tabpanel" id="panel-log" aria-labelledby="tab-log" hidden={tab !== "log"} className="tab-pane"><ErrorBoundary name="Log"><ActivityLog entries={log} totals={totals} /></ErrorBoundary></div>
            <div role="tabpanel" id="panel-replays" aria-labelledby="tab-replays" hidden={tab !== "replays"} className="tab-pane"><ErrorBoundary name="Replays"><Recordings live={live} currentBase={recording.sessionId} replayOf={recording.replayOf} active={tab === "replays"} /></ErrorBoundary></div>
            <div role="tabpanel" id="panel-state" aria-labelledby="tab-state" hidden={tab !== "state"} className="tab-pane">{tab === "state" && <StatePanel />}</div>
            <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" hidden={tab !== "settings"} className="tab-pane"><ErrorBoundary name="Settings"><SettingsPanel settings={settings} live={live} sound={sound} setSound={setSound} muted={muted} setMuted={setMuted} notify={notify} setNotify={setNotify} /></ErrorBoundary></div>
          </div>
        </section>
      </main>
      <Toasts onOpen={openHighlight} onWatch={canWatch ? seekTo : undefined} />
      {authRequired && <Login reason={t("sessionEnded")} onDone={() => location.reload()} />}
      <DialogHost />
      {help && (
        <div className="overlay" onClick={() => setHelp(false)} role="presentation">
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
          <div className="sheet" role="dialog" aria-modal="true" aria-label={t("shortcuts")} onClick={(e) => e.stopPropagation()}>
            <h3>{t("keyboard")}</h3>
            <dl>
              <dt><Kbd k="1" />…<Kbd k="8" /></dt><dd>{t("switchPanel")}</dd>
              {hotkeys.filter((h) => !/^\d$/.test(h.key) && h.key !== "Escape").map((h) => <span key={h.key} className="contents"><dt><Kbd k={h.label} /></dt><dd>{h.help}</dd></span>)}
              <dt><Kbd k="⌘K" /></dt><dd>{t("searchSession")}</dd>
              <dt><Kbd k="← →" /></dt><dd>{t("seek")}</dd>
              <dt><Kbd k="l" /></dt><dd>{t("backToLive")}</dd>
              <dt><Kbd k="⌘⏎" /></dt><dd>{t("addRule")}</dd>
              <dt><Kbd k="esc" /></dt><dd>{t("close")}</dd>
            </dl>
            <p className="muted small">{t("never")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
