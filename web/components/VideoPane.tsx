import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { VideoSource } from "@shared/protocol";

export function VideoPane({ source, viewers, title, live, muted, onToggleMute, recording, onRecord }: { source: VideoSource | null; viewers?: number; title?: string; live: boolean; muted: boolean; onToggleMute: () => void; recording?: { active: boolean; since?: number } | null; onRecord?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "retrying" | "gap">("idle");
  const isFile = source?.kind === "file";
  const key = source ? (source.kind === "hls" ? source.url : `file:${source.startedAt}:${source.segments.length}`) : "";

  useEffect(() => {
    const video = ref.current;
    if (!video || !source) { setState("idle"); return; }

    if (source.kind === "file") {
      // Replay: pick the segment covering the current event time and keep the player within 1.5 s of it.
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

    if (!Hls.isSupported()) { video.src = source.url; void video.play().catch(() => {}); return; }
    const hls = new Hls({ liveSyncDurationCount: 3, lowLatencyMode: true, manifestLoadingMaxRetry: 30, manifestLoadingRetryDelay: 1500, levelLoadingMaxRetry: 30, fragLoadingMaxRetry: 10 });
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    setState("loading");
    hls.loadSource(source.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { setState("playing"); void video.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || disposed) return;
      setState("retrying");
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      clearTimeout(retry);
      retry = setTimeout(() => { if (!disposed) { hls.loadSource(source.url); hls.startLoad(); } }, 2000);
    });
    return () => { disposed = true; clearTimeout(retry); hls.destroy(); };
  }, [key]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);

  const [, tick] = useState(0);
  useEffect(() => { if (!recording?.active) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [recording?.active]);
  const recFor = recording?.active && recording.since ? Math.floor((Date.now() - recording.since) / 1000) : 0;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className={`video ${state}`}>
      {source ? <video ref={ref} muted={muted} playsInline onClick={onToggleMute} /> : (
        <div className="video-empty">{live ? <><span className="spinner" /> waiting for stream</> : "not connected"}</div>
      )}
      {isFile && state === "gap" && <div className="video-gap">no video for this moment</div>}
      <div className="hud top">
        {live && !isFile && <span className="hud-live"><i />LIVE</span>}
        {isFile && <span className="hud-chip" title="recorded video, synced to the replayed events">▶ replay</span>}
        {viewers !== undefined && <span className="hud-chip" title="viewers">👁 {viewers}</span>}
        <span className="grow" />
        {state === "retrying" && <span className="hud-chip warn">reconnecting…</span>}
        {live && !isFile && onRecord && (
          <button className={`hud-btn rec ${recording?.active ? "on" : ""}`} onClick={onRecord} title={recording?.active ? "stop recording (r)" : "record video from now (r)"} aria-pressed={!!recording?.active}>
            <i />{recording?.active ? `REC ${mmss(recFor)}` : "REC"}
          </button>
        )}
        {source && <button className="hud-btn" onClick={onToggleMute} title={muted ? "unmute (m)" : "mute (m)"} aria-label={muted ? "unmute" : "mute"}>{muted ? "🔇" : "🔊"}</button>}
      </div>
      {title && <div className="hud bottom"><span className="hud-title">{title}</span></div>}
    </div>
  );
}
