import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

export function VideoPane({ url, viewers, title, live, muted, onToggleMute }: { url: string | null; viewers?: number; title?: string; live: boolean; muted: boolean; onToggleMute: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "retrying">("idle");
  useEffect(() => {
    const video = ref.current;
    if (!video || !url) { setState("idle"); return; }
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
  }, [url]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  return (
    <div className={`video ${state}`}>
      {url ? <video ref={ref} muted={muted} playsInline onClick={onToggleMute} /> : (
        <div className="video-empty">{live ? <><span className="spinner" /> waiting for stream</> : "not connected"}</div>
      )}
      <div className="hud top">
        {live && <span className="hud-live"><i />LIVE</span>}
        {viewers !== undefined && <span className="hud-chip" title="viewers">👁 {viewers}</span>}
        <span className="grow" />
        {state === "retrying" && <span className="hud-chip warn">reconnecting…</span>}
        {url && <button className="hud-btn" onClick={onToggleMute} title={muted ? "unmute (m)" : "mute (m)"} aria-label={muted ? "unmute" : "mute"}>{muted ? "🔇" : "🔊"}</button>}
      </div>
      {title && <div className="hud bottom"><span className="hud-title">{title}</span></div>}
    </div>
  );
}
