import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Highlight, SourceHealth } from "@shared/protocol";
import type { TranscriptLine } from "../lib/store";
import { fmtTime } from "./ui";
import { useT } from "../i18n";

const M = {
  en: {
    live: "live", stale: "stale · {n} s", noData: "no data", error: "error", lastNever: "last data never", lastAgo: "last data {n} s ago",
    scene: "scene", sceneTitle: "🎥 Scene", waiting: "waiting for first frame…",
    hostSpeech: "host speech", host: "🎙 Host", speaking: "speaking", silent: "silent", lines: "{n} lines", listening: "Listening…", newest: "newest ↓",
  },
  fr: {
    live: "en direct", stale: "périmé · {n} s", noData: "aucune donnée", error: "erreur", lastNever: "dernières données : jamais", lastAgo: "dernières données il y a {n} s",
    scene: "scène", sceneTitle: "🎥 Scène", waiting: "en attente de la première image…",
    hostSpeech: "parole de l'hôte", host: "🎙 Hôte", speaking: "parle", silent: "silence", lines: "{n} lignes", listening: "À l'écoute…", newest: "plus récent ↓",
  },
};

type Sources = Record<"transcript" | "video" | "chat", SourceHealth>;

const SourceState = memo(function SourceState({ h }: { h?: SourceHealth }) {
  const t = useT(M);
  if (!h) return null;
  const cls = h.state === "available" ? "ok" : h.state === "stale" ? "warn" : "bad";
  const secs = Math.round(h.ageMs / 1000);
  const label = h.state === "available" ? t("live") : h.state === "stale" ? t("stale", { n: secs }) : h.state === "missing" ? t("noData") : t("error");
  return <span className={`live-pill ${cls}`} title={h.error ?? (h.ageMs < 0 ? t("lastNever") : t("lastAgo", { n: secs }))}>{label}</span>;
});

/** The latest vision caption of the frame, with the scene flag that matches it. Sits beside the compact player. */
export const ScenePanel = memo(function ScenePanel({ captions, highlights, sources, onOpen }: { captions: { ts: number; text: string }[]; highlights: Highlight[]; sources?: Sources; onOpen: (h: Highlight) => void }) {
  const t = useT(M);
  const cap = captions.at(-1);
  const sceneFlag = useMemo(() => highlights.filter((h) => h.kind === "scene" && !h.resolved).at(-1), [highlights]);
  const sceneFlagged = !!(sceneFlag && cap && Math.abs(sceneFlag.ts - cap.ts) < 15_000);
  return (
    <section className={`panel caption ${sceneFlagged ? "flagged" : ""}`} aria-label={t("scene")}>
      <header className="panel-title">
        <span>{t("sceneTitle")}</span>{cap && <span className="muted mono">{fmtTime(cap.ts)}</span>}
        <span className="grow" />
        {sceneFlagged && <button className="mark-btn" onClick={() => onOpen(sceneFlag!)} title={sceneFlag!.flags.map((f) => f.label).join(", ")}>{sceneFlag!.flags.map((f) => f.label).join(", ")}</button>}
        <SourceState h={sources?.video} />
      </header>
      <p className="caption-text">{cap ? cap.text : <span className="muted">{t("waiting")}</span>}</p>
    </section>
  );
});

export const Transcript = memo(function Transcript({ lines, interim, highlights, sources, onOpen }: { lines: TranscriptLine[]; interim: string; highlights: Highlight[]; sources?: Sources; onOpen: (h: Highlight) => void }) {
  const t = useT(M);
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => { const el = ref.current; if (el && pinned) el.scrollTop = el.scrollHeight; }, [lines.length, interim, pinned]);
  const onScroll = () => { const el = ref.current; if (!el) return; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
  const marks = useMemo(() => {
    const ranges = highlights.filter((h) => h.kind === "transcript" && h.transcript && !h.resolved).map((h) => ({ h, from: h.transcript!.from - 500, to: h.transcript!.to + 500 }));
    const m = new Map<string, Highlight>();
    if (!ranges.length) return m;
    for (const l of lines) { const r = ranges.find((x) => l.ts >= x.from && l.ts <= x.to); if (r) m.set(l.id, r.h); }
    return m;
  }, [lines, highlights]);
  const speaking = !!interim;
  const shown = lines.slice(-80);
  return (
    <section className="panel transcript-panel" aria-label={t("hostSpeech")}>
      <header className="panel-title">
        <span>{t("host")}</span>
        <span className={`speaking ${speaking ? "on" : ""}`} title={speaking ? t("speaking") : t("silent")}><i /><i /><i /></span>
        <span className="muted mono">{lines.length ? t("lines", { n: lines.length }) : ""}</span>
        <span className="grow" />
        <SourceState h={sources?.transcript} />
      </header>
      <div className="transcript" ref={ref} onScroll={onScroll} role="log">
        {shown.map((l, i, arr) => {
          const h = marks.get(l.id);
          const first = h && (i === 0 || marks.get(arr[i - 1].id) !== h);
          const Tag = h ? "button" : "div";
          return (
            <Tag className={`line ${h ? "marked" : ""}`} key={l.id} onClick={h ? () => onOpen(h) : undefined} type={h ? "button" : undefined}>
              <span className="line-time">{fmtTime(l.ts)}</span>
              <span className="line-text">{first && <span className="mark-label">{h!.flags.map((f) => f.label).join(", ")}</span>}{l.text}</span>
            </Tag>
          );
        })}
        {interim && <div className="line interim"><span className="line-time">…</span><span className="line-text">{interim}<span className="caret" /></span></div>}
        {lines.length === 0 && !interim && <div className="empty">{sources?.transcript?.state === "error" ? sources.transcript.error : t("listening")}</div>}
      </div>
      {!pinned && <button className="jump" onClick={() => { setPinned(true); const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }}>{t("newest")}</button>}
    </section>
  );
});
