import { memo } from "react";
import type { HealthInfo } from "@shared/protocol";
import { bytes } from "../lib/format";

/** One line of honest state: what runs, what is paused, what is missing. Empty when everything is fine and idle. */
export const HealthBar = memo(function HealthBar({ health, live, now }: { health: HealthInfo | null; live: boolean; now: number }) {
  if (!health) return null;
  const items: { cls: "ok" | "warn" | "bad"; text: string; title?: string }[] = [];
  if (health.breaker && health.breaker.until > now) items.push({ cls: "bad", text: `paid calls paused: ${health.breaker.reason}`, title: "fix the key or the balance in Settings; the breaker closes on save" });
  if (health.budget.stopped) items.push({ cls: "bad", text: `budget reached ($${health.budget.cap.toFixed(2)}) · paid calls stopped`, title: "raise the session budget in Settings to resume" });
  if (health.rateLimitedUntil > now) items.push({ cls: "warn", text: `rate limited · retry in ${Math.ceil((health.rateLimitedUntil - now) / 1000)} s` });
  if (live) {
    if (health.ffmpeg === "exited") items.push({ cls: "bad", text: "ffmpeg exited" });
    if (health.deepgram === "backoff") items.push({ cls: "warn", text: `speech reconnecting${health.deepgramDetail ? ` · ${health.deepgramDetail}` : ""}` });
    if (health.deepgram === "gave-up") items.push({ cls: "bad", text: "speech off: Deepgram gave up (check the key)", title: health.deepgramDetail });
    if (health.lastTickAt && now - health.lastTickAt > 10_000) items.push({ cls: "warn", text: `no decision for ${Math.round((now - health.lastTickAt) / 1000)} s` });
    if (health.chatBacklog > 20) items.push({ cls: "warn", text: `chat backlog ${health.chatBacklog}` });
  }
  if (health.recorder === "finalizing") items.push({ cls: "ok", text: "finalizing recording…" });
  if (health.diskFreeBytes !== null && health.diskFreeBytes < 2e9) items.push({ cls: "bad", text: `disk: ${bytes(health.diskFreeBytes)} free` });
  if (!items.length) return null;
  return (
    <div className="healthbar" role="status" aria-live="polite">
      {items.map((it, i) => <span key={i} className={`health-item ${it.cls}`} title={it.title}>{it.text}</span>)}
    </div>
  );
});
