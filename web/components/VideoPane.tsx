import { memo, useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { VideoSource } from "@shared/protocol";

type PlayerState = "idle" | "loading" | "playing" | "retrying" | "gap" | "failed";
const MAX_MEDIA_RECOVERIES = 4;

export const VideoPane = memo(function VideoPane({ source, viewers, title, live, muted, onToggleMute, recording, onRecord, reviewTs, onPlayingTs, onSeekResult, size = "compact", onToggleSize }: {
  source: VideoSource | null; viewers?: number; title?: string; live: boolean; muted: boolean; onToggleMute: () => void;
  recording?: { active: boolean; since?: number; finalizing?: boolean } | null; onRecord?: () => void;
  /** wall-clock moment to show in the DVR window; null = live edge */ reviewTs?: number | null;
  onPlayingTs?: (ts: number | null, behindSec: number) => void;
  /** Reports whether a requested moment was inside the DVR window. */
  onSeekResult?: (ts: number, inWindow: boolean) => void;
  /** compact = small 9:16 tile beside the scene caption; large = centered player. */
  size?: "compact" | "large"; onToggleSize?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [state, setState] = useState<PlayerState>("idle");
  const isFile = source?.kind === "file";
  const key = source ? (source.kind === "hls" ? source.url : `file:${source.startedAt}:${source.segments.length}`) : "";
  /** A seek requested before the manifest is parsed is applied once the level is known. */
  const pendingSeek = useRef<number | null | undefined>(undefined);
  const levelReady = useRef(false);

  // DVR seek: map a wall-clock time to a position using the segments' program date time.
  const seekToTs = (ts: number | null) => {
    const hls = hlsRef.current, video = ref.current;
    if (!video || source?.kind !== "hls") return;
    if (!hls) {
      // Native HLS (Safari): map through getStartDate() when the playlist carries program date time.
      const start = (video as HTMLVideoElement & { getStartDate?: () => Date }).getStartDate?.();
      if (ts === null) { if (Number.isFinite(video.duration)) video.currentTime = video.duration; void video.play().catch(() => {}); return; }
      if (start && !Number.isNaN(start.getTime())) { const pos = (ts - start.getTime()) / 1000; const ok = pos >= 0 && (!Number.isFinite(video.duration) || pos <= video.duration); video.currentTime = Math.max(0, pos); onSeekResult?.(ts, ok); void video.play().catch(() => {}); }
      return;
    }
    if (!levelReady.current) { pendingSeek.current = ts; return; }
    if (ts === null) { const edge = hls.liveSyncPosition ?? video.duration; if (Number.isFinite(edge)) video.currentTime = edge; void video.play().catch(() => {}); return; }
    const frags = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0]?.details?.fragments ?? [];
    let pos: number | null = null;
    for (const f of frags) { if (f.programDateTime !== null && f.programDateTime !== undefined && f.programDateTime <= ts) pos = f.start + (ts - f.programDateTime) / 1000; }
    const first = frags[0];
    const inWindow = pos !== null && !(first && first.programDateTime && ts < first.programDateTime);
    if (pos === null && first) pos = first.start;
    onSeekResult?.(ts, inWindow);
    if (pos !== null) { video.currentTime = Math.max(0, pos); void video.play().catch(() => {}); }
  };

  useEffect(() => {
    const video = ref.current;
    if (!video || !source) { setState("idle"); return; }

    if (source.kind === "file") {
      let current: string | null = null;
      const sync = () => {
        const eventTime = source.t0 + (Date.now() - source.startedAt);
        const seg = source.segments.find((x) => eventTime >= x.startTs && eventTime <= x.endTs);
        if (!seg) { if (current) { current = null; video.pause(); video.removeAttribute("src"); video.load(); } setState("gap"); return; }
        const want = (eventTime - seg.startTs) / 1000;
        if (current !== seg.url) { current = seg.url; setState("loading"); video.src = seg.url; video.addEventListener("loadedmetadata", () => { video.currentTime = want; setState("playing"); void video.play().catch(() => {}); }, { once: true }); return; }
        if (Math.abs(video.currentTime - want) > 1.5) video.currentTime = want;
        if (video.paused) void video.play().catch(() => {});
      };
      sync();
      const t = setInterval(sync, 2000);
      return () => { clearInterval(t); video.removeAttribute("src"); video.load(); };
    }

    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let hls: Hls | null = null;
    levelReady.current = false;
    pendingSeek.current = undefined;
    setState("loading");
    // hls.js is loaded on demand: the console paints without it, and the director never needs it.
    void import("hls.js").then(({ default: HlsCtor }) => {
      if (disposed) return;
      if (!HlsCtor.isSupported()) { video.src = source.url; void video.play().catch(() => {}); setState("playing"); return; }
      // Sliding-window DVR: hold near the live edge unless reviewing. No liveMaxLatencyDurationCount: it would drag playback back to the edge.
      hls = new HlsCtor({ liveSyncDurationCount: 3, lowLatencyMode: true, manifestLoadingMaxRetry: 30, manifestLoadingRetryDelay: 1500, levelLoadingMaxRetry: 30, fragLoadingMaxRetry: 10 });
      hlsRef.current = hls;
      let mediaRecoveries = 0;
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(HlsCtor.Events.MANIFEST_PARSED, () => { setState("playing"); void video.play().catch(() => {}); });
      hls.on(HlsCtor.Events.LEVEL_UPDATED, () => {
        if (!levelReady.current) { levelReady.current = true; if (pendingSeek.current !== undefined) { const p = pendingSeek.current; pendingSeek.current = undefined; seekToTs(p); } }
      });
      hls.on(HlsCtor.Events.ERROR, (_e, data) => {
        if (!data.fatal || disposed || !hls) return;
        setState("retrying");
        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
          mediaRecoveries++;
          if (mediaRecoveries <= MAX_MEDIA_RECOVERIES) { if (mediaRecoveries === 3) hls.swapAudioCodec(); hls.recoverMediaError(); return; }
          setState("failed"); return;
        }
        clearTimeout(retry);
        retry = setTimeout(() => { if (!disposed && hls) { hls.loadSource(source.url); hls.startLoad(); } }, 2000);
      });
    });
    return () => { disposed = true; clearTimeout(retry); hls?.destroy(); hlsRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  useEffect(() => { if (source?.kind === "hls") { const t = setTimeout(() => seekToTs(reviewTs ?? null), 100); return () => clearTimeout(t); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewTs, key]);

  // Report where playback is on the wall clock, so the timeline can draw the playhead and "behind live". Only on change.
  useEffect(() => {
    if (source?.kind !== "hls" || !onPlayingTs) return;
    let last = { ts: -1, behind: -1 };
    const t = setInterval(() => {
      const hls = hlsRef.current, video = ref.current;
      if (!video) return;
      const pd = hls?.playingDate ?? null;
      const edge = hls?.liveSyncPosition ?? video.duration;
      const behind = Number.isFinite(edge) ? Math.max(0, Math.round(edge - video.currentTime)) : 0;
      const ts = pd ? Math.round(pd.getTime() / 1000) * 1000 : -1;
      if (ts === last.ts && behind === last.behind) return;
      last = { ts, behind };
      onPlayingTs(ts >= 0 ? ts : null, behind);
    }, 500);
    return () => clearInterval(t);
  }, [key, onPlayingTs, source?.kind]);

  const [, tick] = useState(0);
  useEffect(() => { if (!recording?.active) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [recording?.active]);
  const recFor = recording?.active && recording.since ? Math.floor((Date.now() - recording.since) / 1000) : 0;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className={`video ${state}`}>
      {source ? <video ref={ref} muted={muted} playsInline onClick={onToggleMute} aria-label="stream video" /> : (
        <div className="video-empty">{live ? <><span className="spinner" /> waiting for stream</> : "not connected"}</div>
      )}
      {isFile && state === "gap" && <div className="video-gap">no video for this moment</div>}
      {state === "failed" && <div className="video-gap">playback failed · <button className="chip-btn" onClick={() => location.reload()}>reload</button></div>}
      {/* Two short HUD rows so everything still fits on the compact 9:16 tile. */}
      <div className="hud top">
        {live && !isFile && (reviewTs ? <span className="hud-chip dvr">⏪ REVIEW</span> : <span className="hud-live"><i />LIVE</span>)}
        {isFile && <span className="hud-chip" title="recorded video, synced to the replayed events">▶ replay</span>}
        {viewers !== undefined && <span className="hud-chip" title="viewers">👁 {viewers}</span>}
        <span className="grow" />
        {state === "retrying" && <span className="hud-chip warn">reconnecting…</span>}
        {source && <button className="hud-btn" onClick={onToggleMute} title={muted ? "unmute (m)" : "mute (m)"} aria-label={muted ? "unmute" : "mute"} aria-pressed={!muted}>{muted ? "🔇" : "🔊"}</button>}
      </div>
      <div className="hud bottom">
        {recording?.finalizing && <span className="hud-chip warn" title="the stopped segment is being remuxed into a seekable file">finalizing…</span>}
        {live && !isFile && onRecord && (
          <button className={`hud-btn rec ${recording?.active ? "on" : ""}`} onClick={onRecord} title={recording?.active ? "stop recording (r)" : "record video from now (r)"} aria-pressed={!!recording?.active}>
            <i />{recording?.active ? `REC ${mmss(recFor)}` : "REC"}
          </button>
        )}
        {title && size === "large" && <span className="hud-title" title={title}>{title}</span>}
        <span className="grow" />
        {onToggleSize && <button className="hud-btn" onClick={onToggleSize} title={size === "large" ? "compact player (v)" : "large player (v)"} aria-label={size === "large" ? "compact player" : "large player"}>{size === "large" ? "⤡" : "⤢"}</button>}
      </div>
    </div>
  );
});
