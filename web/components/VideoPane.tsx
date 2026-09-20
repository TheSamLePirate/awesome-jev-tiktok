import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { VideoSource } from "@shared/protocol";

export function VideoPane({ source, viewers, title, live, muted, onToggleMute }: { source: VideoSource | null; viewers?: number; title?: string; live: boolean; muted: boolean; onToggleMute: () => void }) {
  const url = source?.url ?? null;
  const isFile = source?.kind === "file";
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "retrying">("idle");
  useEffect(() => {
    const video = ref.current;
    if (!video || !url || !source) { setState("idle"); return; }
    if (source.kind === "file") {
      // Recorded replay: plain file playback, seeked so the picture matches the replayed events.
      setState("loading");
      video.src = source.url;
      const sync = () => { const want = source.offsetSec + (Date.now() - source.startedAt) / 1000; if (Math.abs(video.currentTime - want) > 1.5) video.currentTime = want; };
      const onMeta = () => { sync(); setState("playing"); void video.play().catch(() => {}); };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("canplay", sync, { once: true });
      const t = setInterval(sync, 3000);
      return () => { clearInterval(t); video.removeEventListener("loadedmetadata", onMeta); video.removeEventListener("canplay", sync); video.removeAttribute("src"); video.load(); };
    }
    if (!Hls.isSupported()) { video.src = url; void video.play().catch(() => {}); return; }
    const hls = new Hls({ liveSyncDurationCount: 3, lowLatencyMode: true, manifestLoadingMaxRetry: 30, manifestLoadingRetryDelay: 1500, levelLoadingMaxRetry: 30, fragLoadingMaxRetry: 10 });
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    setState("loading");
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { setState("playing"); void video.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || disposed) return;
      setState("retrying");
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      clearTimeout(retry);
      retry = setTimeout(() => { if (!disposed) { hls.loadSource(url); hls.startLoad(); } }, 2000);
    });
    return () => { disposed = true; clearTimeout(retry); hls.destroy(); };
  }, [url, source?.kind, isFile ? (source as any).startedAt : 0]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  return (
    <div className={`video ${state}`}>
      {url ? <video ref={ref} muted={muted} playsInline onClick={onToggleMute} /> : (
        <div className="video-empty">{live ? <><span className="spinner" /> waiting for stream</> : "not connected"}</div>
      )}
      <div className="hud top">
        {live && !isFile && <span className="hud-live"><i />LIVE</span>}
        {isFile && <span className="hud-chip" title="recorded video, synced to the replayed events">▶ replay</span>}
        {viewers !== undefined && <span className="hud-chip" title="viewers">👁 {viewers}</span>}
        <span className="grow" />
        {state === "retrying" && <span className="hud-chip warn">reconnecting…</span>}
        {url && <button className="hud-btn" onClick={onToggleMute} title={muted ? "unmute (m)" : "mute (m)"} aria-label={muted ? "unmute" : "mute"}>{muted ? "🔇" : "🔊"}</button>}
      </div>
      {title && <div className="hud bottom"><span className="hud-title">{title}</span></div>}
    </div>
  );
}
