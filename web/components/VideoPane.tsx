import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

export function VideoPane({ url }: { url: string | null }) {
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
    // The server rewrites the HLS folder on every reconnect; keep retrying until the playlist is back.
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || disposed) return;
      setState("retrying");
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      clearTimeout(retry);
      retry = setTimeout(() => { if (!disposed) { hls.loadSource(url); hls.startLoad(); } }, 2000);
    });
    return () => { disposed = true; clearTimeout(retry); hls.destroy(); };
  }, [url]);
  return (
    <div className="video">
      {url ? <video ref={ref} muted playsInline controls /> : <div className="video-empty">no video yet</div>}
      {url && state === "retrying" && <div className="video-badge">reconnecting…</div>}
    </div>
  );
}
