import { useEffect, useRef } from "react";
import Hls from "hls.js";

export function VideoPane({ url }: { url: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !url) return;
    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3, lowLatencyMode: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => {}));
      return () => hls.destroy();
    }
    video.src = url;
    void video.play().catch(() => {});
  }, [url]);
  return (
    <div className="video">
      {url ? <video ref={ref} muted playsInline controls /> : <div className="video-empty">no video yet</div>}
    </div>
  );
}
