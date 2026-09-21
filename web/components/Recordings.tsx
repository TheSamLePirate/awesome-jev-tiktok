import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { RecordingInfo, RecordingPeek } from "@shared/protocol";
import { api } from "../lib/api";
import { bytes as mb, duration as dur, when } from "../lib/format";
import { plural, useT } from "../i18n";
import { toast } from "../lib/store";
import { confirm } from "./Dialog";
import { fmtTime } from "./ui";

const M = {
  en: {
    timelineTitle: "activity per minute: chat (blue) and host speech (orange); bars below show where video exists",
    deleteTitle: "Delete \"{name}\"?", deleteBody: "{events} events{videos}. This cannot be undone.", videoOne: " and {n} video file ({size})", videoMany: " and {n} video files ({size})", delete: "Delete", deleted: "Recording deleted",
    searchPh: "search recordings…", search: "search recordings", totals: "{n} sessions · {videos} videos · {size}", refresh: "refresh",
    loading: "Loading…", empty: "No recordings yet. Every connected session is recorded here.",
    recordingNow: "recording now", replaying: "replaying", clips: "{n} clips · ", chat: "{n} chat", lines: "{n} lines", downloadVideo: "download video",
    host: "Host", chatHead: "Chat", disconnectFirst: "disconnect first", replayTitle: "replay this session (events only; jev is called unless dry run is on in Settings)", replay: "▶ Replay",
    simulateTitle: "play the video through the real media pipeline as if it were live (dev)", simulate: "⚙ Simulate live", downloadEvents: "download events", events: "⤓ events",
    inProgress: "session in progress", deleteThis: "delete this recording", deleteBtn: "🗑 delete",
    keepKeep: "keep", keepOk: "ok", keepExpendable: "expendable", keepTitle: "jev's retention verdict: {reason}",
  },
  fr: {
    timelineTitle: "activité par minute : chat (bleu) et parole du streamer (orange) ; les barres en dessous montrent où il y a de la vidéo",
    deleteTitle: "Supprimer « {name} » ?", deleteBody: "{events} événements{videos}. Cette action est irréversible.", videoOne: " et {n} fichier vidéo ({size})", videoMany: " et {n} fichiers vidéo ({size})", delete: "Supprimer", deleted: "Enregistrement supprimé",
    searchPh: "chercher un enregistrement…", search: "chercher un enregistrement", totals: "{n} sessions · {videos} vidéos · {size}", refresh: "rafraîchir",
    loading: "Chargement…", empty: "Pas encore d'enregistrement. Chaque session connectée est enregistrée ici.",
    recordingNow: "en cours d'enregistrement", replaying: "en relecture", clips: "{n} clips · ", chat: "{n} chat", lines: "{n} phrases", downloadVideo: "télécharger la vidéo",
    host: "Streamer", chatHead: "Chat", disconnectFirst: "déconnecte-toi d'abord", replayTitle: "rejouer cette session (événements seulement ; jev est appelé sauf si l'essai à blanc est activé dans les réglages)", replay: "▶ Rejouer",
    simulateTitle: "lire la vidéo à travers le vrai pipeline média comme si c'était en direct (dev)", simulate: "⚙ Simuler le direct", downloadEvents: "télécharger les événements", events: "⤓ événements",
    inProgress: "session en cours", deleteThis: "supprimer cet enregistrement", deleteBtn: "🗑 supprimer",
    keepKeep: "à garder", keepOk: "ok", keepExpendable: "dispensable", keepTitle: "verdict de rétention de jev : {reason}",
  },
};

function Timeline({ peek, durationSec, videos, t0 }: { peek: RecordingPeek; durationSec?: number; videos: RecordingInfo["videos"]; t0: number }) {
  const t = useT(M);
  const minutes = Math.max(1, Math.ceil((durationSec ?? 60) / 60));
  const max = Math.max(1, ...peek.timeline.map((b) => b.chat + b.transcript));
  return (
    <div className="rec-timeline" title={t("timelineTitle")}>
      <div className="rec-bars" style={{ gridTemplateColumns: `repeat(${minutes}, 1fr)` }}>
        {Array.from({ length: minutes }, (_, i) => { const b = peek.timeline.find((x) => x.t === i); return <span key={i} className="rec-bar"><i className="chat" style={{ height: `${((b?.chat ?? 0) / max) * 100}%` }} /><i className="talk" style={{ height: `${((b?.transcript ?? 0) / max) * 100}%` }} /></span>; })}
      </div>
      <div className="rec-videos-track">
        {videos.map((v) => { const total = minutes * 60_000; const left = Math.max(0, (v.startTs - t0) / total) * 100; const width = Math.min(100 - left, (((v.endTs ?? v.startTs) - v.startTs) / total) * 100); return <span key={v.file} className="rec-video-span" style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }} title={`${v.file} · ${dur(v.durationSec)} · ${mb(v.sizeBytes)}`} />; })}
      </div>
    </div>
  );
}

/** `active` pauses the polling while the panel is hidden (it stays mounted so the selection survives a tab switch). */
export const Recordings = memo(function Recordings({ live, currentBase, replayOf, active }: { live: boolean; currentBase?: string; replayOf?: string; active: boolean }) {
  const t = useT(M);
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [peek, setPeek] = useState<RecordingPeek | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => api.recordings().then(setList).catch(() => setList((l) => l ?? [])), []);
  useEffect(() => { if (!active) return; void refresh(); const iv = setInterval(refresh, 15_000); return () => clearInterval(iv); }, [live, active, refresh]);
  const select = useCallback((id: string | null) => { setSelected(id); setPeek(null); }, []);
  useEffect(() => { if (!selected) return; let stop = false; void api.peekRecording(selected).then((p) => { if (!stop) setPeek(p); }).catch(() => { if (!stop) setPeek(null); }); return () => { stop = true; }; }, [selected]);
  const rows = useMemo(() => (list ?? []).filter((r) => !search || `${r.username} ${r.title ?? ""} ${r.id}`.toLowerCase().includes(search.toLowerCase())), [list, search]);
  const totals = useMemo(() => ({ n: list?.length ?? 0, size: (list ?? []).reduce((a, r) => a + r.sizeBytes, 0), videos: (list ?? []).reduce((a, r) => a + r.videos.length, 0) }), [list]);
  const remove = async (r: RecordingInfo) => {
    const videos = r.videos.length ? plural(r.videos.length, t("videoOne"), t("videoMany"), { size: mb(r.videos.reduce((a, v) => a + v.sizeBytes, 0)) }) : "";
    const ok = await confirm({ title: t("deleteTitle", { name: `${r.username} · ${when(r.createdAt)}` }), body: t("deleteBody", { events: r.eventCount, videos }), confirmLabel: t("delete"), danger: true });
    if (!ok) return;
    setBusy(r.id);
    try { await api.deleteRecording(r.id); if (selected === r.id) select(null); void refresh(); toast({ kind: "info", title: t("deleted") }); }
    catch { /* toasted */ } finally { setBusy(null); }
  };
  const replay = async (r: RecordingInfo, simulate = false) => { setBusy(r.id); try { await api.connect("replay", r.id, { simulate }); } catch { /* toasted */ } finally { setBusy(null); } };
  return (
    <div className="recs">
      <div className="recs-toolbar">
        <input className="search" name="recordings-search" placeholder={t("searchPh")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("search")} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" />
        <span className="muted mono">{t("totals", { n: totals.n, videos: totals.videos, size: mb(totals.size) })}</span>
        <button className="icon" onClick={refresh} title={t("refresh")} aria-label={t("refresh")}>↻</button>
      </div>
      <div className="recs-list">
        {list === null && <div className="empty">{t("loading")}</div>}
        {list !== null && rows.length === 0 && <div className="empty">{t("empty")}</div>}
        {rows.map((r) => {
          const isCurrent = !!currentBase && currentBase === r.id;
          const isReplaying = replayOf === r.id;
          const open = selected === r.id;
          return (
            <div key={r.id} className={`rec ${open ? "on" : ""} ${isCurrent ? "current" : ""}`}>
              <button className="rec-head as-row" onClick={() => select(open ? null : r.id)} aria-expanded={open}>
                <span className="rec-user">@{r.username}</span>
                {r.title && <span className="rec-title">{r.title}</span>}
                {r.keep && <span className={`badge keep-${r.keep}`} title={t("keepTitle", { reason: r.keepReason ?? "" })}>{t(r.keep === "keep" ? "keepKeep" : r.keep === "ok" ? "keepOk" : "keepExpendable")}</span>}
                <span className="grow" />
                {isCurrent && <span className="badge mod">{t("recordingNow")}</span>}
                {isReplaying && <span className="badge add">{t("replaying")}</span>}
                {r.videos.length > 0 && <span className="rec-chip has-video" title={r.videos.map((v) => `${v.file} · ${dur(v.durationSec)}`).join("\n")}>🎥 {r.videos.length > 1 ? t("clips", { n: r.videos.length }) : ""}{dur(r.videos.reduce((a, v) => a + v.durationSec, 0))}</span>}
              </button>
              <div className="rec-meta mono">
                <span>{when(r.createdAt)}</span><span>{dur(r.durationSec)}</span><span>{t("chat", { n: r.chatCount })}</span><span>{t("lines", { n: r.transcriptCount })}</span><span>{mb(r.sizeBytes)}</span>
              </div>
              {open && (
                <div className="rec-detail">
                  {peek ? <Timeline peek={peek} durationSec={r.durationSec} videos={r.videos} t0={peek.chat[0]?.ts && peek.transcript[0]?.ts ? Math.min(peek.chat[0].ts, peek.transcript[0].ts) : (peek.chat[0]?.ts ?? peek.transcript[0]?.ts ?? r.createdAt)} /> : <div className="skeleton" />}
                  {r.videos.length > 0 && (
                    <ul className="rec-videos">
                      {r.videos.map((v) => <li key={v.file}><span className="mono">🎥 {v.file}</span><span className="muted mono">{fmtTime(v.startTs)} → {v.endTs ? fmtTime(v.endTs) : "…"} · {dur(v.durationSec)} · {mb(v.sizeBytes)}</span><a className="icon" href={`/recordings/${v.file}`} download title={t("downloadVideo")}>⤓</a></li>)}
                    </ul>
                  )}
                  {peek && (
                    <div className="rec-peek">
                      {peek.captions[0] && <p className="rec-caption">🎥 {peek.captions[0].text}</p>}
                      {peek.transcript.length > 0 && <div className="rec-col"><h4>{t("host")}</h4>{peek.transcript.slice(0, 6).map((l, i) => <p key={i}><span className="mono q-time">{fmtTime(l.ts)}</span> {l.text}</p>)}</div>}
                      {peek.chat.length > 0 && <div className="rec-col"><h4>{t("chatHead")}</h4>{peek.chat.slice(0, 8).map((m, i) => <p key={i}><b>{m.nickname || m.handle}</b> {m.text}</p>)}</div>}
                    </div>
                  )}
                  <div className="rec-actions">
                    <button className="primary" disabled={live || busy === r.id} onClick={() => replay(r)} title={live ? t("disconnectFirst") : t("replayTitle")}>{t("replay")}</button>
                    {r.videos.length > 0 && <button disabled={live || busy === r.id} onClick={() => replay(r, true)} title={t("simulateTitle")}>{t("simulate")}</button>}
                    <a className="icon" href={`/recordings/${r.id}.jsonl`} download title={t("downloadEvents")}>{t("events")}</a>
                    <span className="grow" />
                    <button className="icon danger" disabled={busy === r.id || isCurrent || isReplaying} title={isReplaying ? t("disconnectFirst") : isCurrent ? t("inProgress") : t("deleteThis")} onClick={() => remove(r)}>{busy === r.id ? "…" : t("deleteBtn")}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
