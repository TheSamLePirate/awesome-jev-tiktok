import { memo } from "react";
import type { AssistState, HealthInfo } from "@shared/protocol";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { bytes } from "../lib/format";
import { useT } from "../i18n";

const M = {
  en: {
    breaker: "paid calls paused: {reason}", breakerHint: "fix the key or the balance in Settings; the breaker closes on save",
    budget: "budget reached (${cap}) · paid calls stopped", budgetHint: "raise the session budget in Settings to resume",
    rateLimited: "rate limited · retry in {n} s", ffmpeg: "ffmpeg exited", speechReconnecting: "speech reconnecting", speechOff: "speech off: Deepgram gave up (check the key)",
    noDecision: "no decision for {n} s", backlog: "chat backlog {n}", finalizing: "finalizing recording…", disk: "disk: {free} free",
    budget80: "budget: {pct}% spent", degrade1: "budget low · vision paused", degrade2: "budget low · vision and chat judging paused", degradeHint: "jev keeps the room rules to the end; raise the session budget to resume everything",
    repairApplied: "jev repaired: {detail}", repairSuggest: "jev suggests: {detail}", reconnect: "reconnect", regime: "room {regime}", regimeHint: "jev's attention regime: a calm room ticks 3× slower",
  },
  fr: {
    breaker: "appels payants en pause : {reason}", breakerHint: "corrige la clé ou le solde dans les réglages ; le disjoncteur se referme à l'enregistrement",
    budget: "budget atteint (${cap}) · appels payants arrêtés", budgetHint: "augmente le budget de session dans les réglages pour reprendre",
    rateLimited: "débit limité · nouvel essai dans {n} s", ffmpeg: "ffmpeg s'est arrêté", speechReconnecting: "reconnexion de la transcription", speechOff: "transcription coupée : Deepgram a abandonné (vérifie la clé)",
    noDecision: "aucune décision depuis {n} s", backlog: "chat en retard : {n}", finalizing: "finalisation de l'enregistrement…", disk: "disque : {free} libres",
    budget80: "budget : {pct} % dépensés", degrade1: "budget bas · vision en pause", degrade2: "budget bas · vision et jugement du chat en pause", degradeHint: "jev garde les règles de salle jusqu'au bout ; augmente le budget de session pour tout reprendre",
    repairApplied: "jev a réparé : {detail}", repairSuggest: "jev suggère : {detail}", reconnect: "reconnecter", regime: "salle {regime}", regimeHint: "régime d'attention de jev : une salle calme tourne 3× moins vite",
  },
};

/** One line of honest state: what runs, what is paused, what is missing. Empty when everything is fine and idle. */
export const HealthBar = memo(function HealthBar({ health, live, now }: { health: HealthInfo | null; live: boolean; now: number }) {
  const t = useT(M);
  const assist = useStore((s) => s.assist);
  if (!health) return null;
  const items: { cls: "ok" | "warn" | "bad"; text: string; title?: string; action?: { label: string; run: () => void } }[] = [];
  const a: AssistState | null = assist;
  if (a && live) {
    if (a.degrade > 0) items.push({ cls: "warn", text: t(a.degrade === 2 ? "degrade2" : "degrade1"), title: t("degradeHint") });
    else if (a.budgetAlert && health.budget.cap > 0 && !health.budget.stopped) items.push({ cls: "warn", text: t("budget80", { pct: Math.round((health.budget.spent / health.budget.cap) * 100) }) });
    if (a.repair && a.repair.action !== "none" && now - a.repair.at < 10 * 60_000) items.push({ cls: a.repair.applied ? "ok" : "warn", text: t(a.repair.applied ? "repairApplied" : "repairSuggest", { detail: a.repair.detail }), action: a.repair.action === "reconnect" && !a.repair.applied ? { label: t("reconnect"), run: () => void api.disconnect().then(() => api.watch(true)).catch(() => {}) } : undefined });
    if (a.regime && a.regime !== "normal") items.push({ cls: "ok", text: t("regime", { regime: a.regime }), title: t("regimeHint") });
  }
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
      {items.map((it, i) => <span key={i} className={`health-item ${it.cls}`} title={it.title}>{it.text}{it.action && <button className="chip-btn" onClick={it.action.run}>{it.action.label}</button>}</span>)}
    </div>
  );
});
