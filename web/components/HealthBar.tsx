import { memo } from "react";
import type { HealthInfo } from "@shared/protocol";
import { bytes } from "../lib/format";
import { useT } from "../i18n";

const M = {
  en: {
    breaker: "paid calls paused: {reason}", breakerHint: "fix the key or the balance in Settings; the breaker closes on save",
    budget: "budget reached (${cap}) · paid calls stopped", budgetHint: "raise the session budget in Settings to resume",
    rateLimited: "rate limited · retry in {n} s", ffmpeg: "ffmpeg exited", speechReconnecting: "speech reconnecting", speechOff: "speech off: Deepgram gave up (check the key)",
    noDecision: "no decision for {n} s", backlog: "chat backlog {n}", finalizing: "finalizing recording…", disk: "disk: {free} free",
  },
  fr: {
    breaker: "appels payants en pause : {reason}", breakerHint: "corrige la clé ou le solde dans les réglages ; le disjoncteur se referme à l'enregistrement",
    budget: "budget atteint (${cap}) · appels payants arrêtés", budgetHint: "augmente le budget de session dans les réglages pour reprendre",
    rateLimited: "débit limité · nouvel essai dans {n} s", ffmpeg: "ffmpeg s'est arrêté", speechReconnecting: "reconnexion de la transcription", speechOff: "transcription coupée : Deepgram a abandonné (vérifie la clé)",
    noDecision: "aucune décision depuis {n} s", backlog: "chat en retard : {n}", finalizing: "finalisation de l'enregistrement…", disk: "disque : {free} libres",
  },
};

/** One line of honest state: what runs, what is paused, what is missing. Empty when everything is fine and idle. */
export const HealthBar = memo(function HealthBar({ health, live, now }: { health: HealthInfo | null; live: boolean; now: number }) {
  const t = useT(M);
  if (!health) return null;
  const items: { cls: "ok" | "warn" | "bad"; text: string; title?: string }[] = [];
  if (health.breaker && health.breaker.until > now) items.push({ cls: "bad", text: t("breaker", { reason: health.breaker.reason }), title: t("breakerHint") });
  if (health.budget.stopped) items.push({ cls: "bad", text: t("budget", { cap: health.budget.cap.toFixed(2) }), title: t("budgetHint") });
  if (health.rateLimitedUntil > now) items.push({ cls: "warn", text: t("rateLimited", { n: Math.ceil((health.rateLimitedUntil - now) / 1000) }) });
  if (live) {
    if (health.ffmpeg === "exited") items.push({ cls: "bad", text: t("ffmpeg") });
    if (health.deepgram === "backoff") items.push({ cls: "warn", text: `${t("speechReconnecting")}${health.deepgramDetail ? ` · ${health.deepgramDetail}` : ""}` });
    if (health.deepgram === "gave-up") items.push({ cls: "bad", text: t("speechOff"), title: health.deepgramDetail });
    if (health.lastTickAt && now - health.lastTickAt > 10_000) items.push({ cls: "warn", text: t("noDecision", { n: Math.round((now - health.lastTickAt) / 1000) }) });
    if (health.chatBacklog > 20) items.push({ cls: "warn", text: t("backlog", { n: health.chatBacklog }) });
  }
  if (health.recorder === "finalizing") items.push({ cls: "ok", text: t("finalizing") });
  if (health.diskFreeBytes !== null && health.diskFreeBytes < 2e9) items.push({ cls: "bad", text: t("disk", { free: bytes(health.diskFreeBytes) }) });
  if (!items.length) return null;
  return (
    <div className="healthbar" role="status" aria-live="polite">
      {items.map((it, i) => <span key={i} className={`health-item ${it.cls}`} title={it.title}>{it.text}</span>)}
    </div>
  );
});
