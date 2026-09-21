// Pure logic of the director view: preferences, URL overrides, the prompt queue, audience numbers, the countdown and notes.
import type { ChatEvent, Decision, Highlight, HighlightKind, JevAnswer, MessageDecision, QuestionScope, Rule, Source, WatchQuestion } from "@shared/protocol";
import type { SocialEvent } from "../lib/store";
import { answerShort } from "../lib/format";
import { tr } from "../i18n";

const M = {
  en: {
    stage: "Stage", stageHint: "room meters and the prompt queue",
    focus: "Focus", focusHint: "one prompt at a time, readable from across the room",
    dashboard: "Dashboard", dashboardHint: "audience numbers, meters, queue and events",
    overlay: "Overlay", overlayHint: "OBS lower third: the featured prompt and the ticker",
    replyTo: "Reply to", youSaid: "You said", onCamera: "On camera", room: "Room",
    watch: "⚠ Watch {who}", checkCamera: "🎥 Check the camera", na: "n/a",
    thank: "🎁 Thank {who}", promised: "📌 You promised", faqReady: "💡 Answer ready", forGift: "for {gift}",
  },
  fr: {
    stage: "Scène", stageHint: "les jauges de la salle et la file des prompts",
    focus: "Focus", focusHint: "un prompt à la fois, lisible de l'autre bout de la pièce",
    dashboard: "Tableau de bord", dashboardHint: "chiffres d'audience, jauges, file et événements",
    overlay: "Overlay", overlayHint: "bandeau OBS : le prompt mis en avant et le ticker",
    replyTo: "Réponds à", youSaid: "Tu as dit", onCamera: "À l'image", room: "Salle",
    watch: "⚠ Surveille {who}", checkCamera: "🎥 Regarde la caméra", na: "n/d",
    thank: "🎁 Remercie {who}", promised: "📌 Tu as promis", faqReady: "💡 Réponse prête", forGift: "pour {gift}",
  },
};
/** Read at each call, so a pure helper follows a language switch (its callers re-render through useT / useLang). */
const t = tr(M);

export type Layout = "stage" | "focus" | "dashboard" | "overlay";
export type Order = "newest" | "oldest";

export interface DirectorPrefs {
  layout: Layout; order: Order;
  /** seconds a prompt stays on stage unless featured */ ttlSec: number;
  maxCards: number; snoozeMin: number; scale: number;
  /** question ids whose prompts are not shown */ hidden: string[];
  showMeters: boolean; showChat: boolean; showWarnings: boolean; showNotes: boolean; showClock: boolean;
  transparent: boolean; sound: boolean; celebrations: boolean;
  /** run of show, one line per item; "- " lines are checkable */ notes: string; notesDone: string[];
}
export const DEFAULT_PREFS: DirectorPrefs = { layout: "stage", order: "newest", ttlSec: 45, maxCards: 4, snoozeMin: 3, scale: 1, hidden: [], showMeters: true, showChat: true, showWarnings: true, showNotes: false, showClock: true, transparent: false, sound: false, celebrations: true, notes: "", notesDone: [] };

/** `label` and `hint` are read in the current language each time. */
export const LAYOUTS: { id: Layout; icon: string; readonly label: string; readonly hint: string }[] = [
  { id: "stage", icon: "▦", get label() { return t("stage"); }, get hint() { return t("stageHint"); } },
  { id: "focus", icon: "◎", get label() { return t("focus"); }, get hint() { return t("focusHint"); } },
  { id: "dashboard", icon: "▤", get label() { return t("dashboard"); }, get hint() { return t("dashboardHint"); } },
  { id: "overlay", icon: "▬", get label() { return t("overlay"); }, get hint() { return t("overlayHint"); } },
];

/** Animation and lifetime knobs; tests shorten them. */
export const TIMING = { burstMs: 4000, timerLingerMs: 8000, leaveMs: 260 };

export const KIND: Record<HighlightKind, { icon: string; readonly verb: string }> = {
  message: { icon: "💬", get verb() { return t("replyTo"); } },
  transcript: { icon: "🎙", get verb() { return t("youSaid"); } },
  scene: { icon: "🎥", get verb() { return t("onCamera"); } },
  room: { icon: "✦", get verb() { return t("room"); } },
};

export const whoOf = (h: Highlight) => (h.message ? h.message.nickname || h.message.handle : "");
/** The server tags moderation-like flags as warnings: something to watch, not an invitation to reply. */
export const cardTitle = (h: Highlight) => (h.assist?.kind === "thanks" ? t("thank", { who: h.assist.nickname || h.assist.handle }) : h.assist?.kind === "promise" ? t("promised") : h.kind === "message" ? (h.severity === "warn" ? t("watch", { who: whoOf(h) }) : `${KIND.message.icon} ${KIND.message.verb} ${whoOf(h)}`) : h.kind === "transcript" ? `${KIND.transcript.icon} ${KIND.transcript.verb}` : h.kind === "scene" ? t("checkCamera") : `${KIND.room.icon} ${KIND.room.verb}`);
export const cardBody = (h: Highlight): string => (h.assist?.kind === "thanks" ? `${t("forGift", { gift: `${h.assist.gift}${h.assist.count > 1 ? ` ×${h.assist.count}` : ""}` })} · 💎 ${h.assist.diamonds}` : h.assist?.kind === "promise" ? h.assist.text : h.message ? h.message.text : h.transcript ? `“${h.transcript.lines.map((l) => l.text).join(" ").slice(-220)}”` : h.scene ? h.scene.text : h.chat ? h.chat.slice(-3).map((c) => `${c.handle}: ${c.text}`).join(" · ") : "");
export const flagText = (h: Highlight) => h.flags.map((f) => `${f.label} ${answerShort(f.answer)}`).join(" · ");

/** Query-string overrides for one browser source (OBS); never saved. */
export function urlOverrides(search: string): Partial<DirectorPrefs> {
  const q = new URLSearchParams(search);
  const o: Partial<DirectorPrefs> = {};
  if (q.get("transparent") === "1") o.transparent = true;
  const sc = Number(q.get("scale"));
  if (sc > 0) o.scale = sc;
  if (q.get("warnings") === "0") o.showWarnings = false;
  if (q.get("ticker") === "0") o.showChat = false;
  if (q.get("meters") === "0") o.showMeters = false;
  const layout = q.get("layout");
  if (layout && LAYOUTS.some((l) => l.id === layout)) o.layout = layout as Layout;
  return o;
}

export interface CardFilter { hidden: Set<string>; showWarnings: boolean; ttlSec: number; maxCards: number; order: Order; snoozed: Map<string, number>; now: number }
/** The queue: open prompts that are not hidden, snoozed or expired; featured first, then warnings, then by age. */
export function selectCards(highlights: Highlight[], f: CardFilter): Highlight[] {
  const alive = highlights.filter((h) => !h.resolved && !h.flags.every((x) => f.hidden.has(x.questionId)) && (f.showWarnings || h.severity !== "warn") && (h.pinned || f.now - h.ts < f.ttlSec * 1000) && (f.snoozed.get(h.id) ?? 0) <= f.now);
  alive.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.severity === "warn") - Number(a.severity === "warn") || (f.order === "newest" ? b.ts - a.ts : a.ts - b.ts));
  return alive.slice(0, f.maxCards);
}

/** Unanswered chat prompts of the last 10 minutes (warnings excluded). */
export const waitingCount = (highlights: Highlight[], hidden: Set<string>, now: number) => highlights.filter((h) => !h.resolved && h.kind === "message" && now - h.ts < 10 * 60_000 && !h.flags.every((f) => hidden.has(f.questionId)) && h.severity !== "warn").length;

export interface Audience { diamonds: number; gifts: number; follows: number; shares: number; joins: number; leaders: { handle: string; diamonds: number }[] }
export function audience(social: SocialEvent[]): Audience {
  const a: Audience = { diamonds: 0, gifts: 0, follows: 0, shares: 0, joins: 0, leaders: [] };
  const per = new Map<string, number>();
  for (const e of social) {
    if (e.kind === "gift") { const d = e.diamonds * e.count; a.diamonds += d; a.gifts += e.count; per.set(e.handle, (per.get(e.handle) ?? 0) + d); }
    else if (e.kind === "social") { if (e.action === "follow") a.follows++; else if (e.action === "share") a.shares++; }
    else a.joins++;
  }
  a.leaders = [...per.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([handle, diamonds]) => ({ handle, diamonds }));
  return a;
}

export interface RuleRow {
  id: string; label: string; scope: QuestionScope; sources: Source[];
  /** keyword / regex rule, evaluated in-process */ local: boolean; paused: boolean;
  /** hidden from the prompt queue by this screen's settings */ muted: boolean;
  /** room rules: the latest answer and its recent history */ answer?: JevAnswer; fired: boolean; skipped: boolean; history: number[];
  /** flags this session, and the latest one */ fires: number; lastFire: number | null; last?: Highlight;
  /** chat rules: messages judged (of the chat kept on screen) and how many matched */ judged: number; matched: number;
}
export interface RuleInputs { rules: Rule[]; decisions: Decision[]; messageDecisions: Record<string, MessageDecision>; highlights: Highlight[]; sessionId: string | null; hidden: Set<string> }
/** One row per question of the active set: what every rule says right now and what it did this session. */
export function ruleRows(qs: WatchQuestion[], i: RuleInputs): RuleRow[] {
  const last = i.decisions.at(-1);
  const recent = i.decisions.slice(-40);
  const mine = i.highlights.filter((h) => !i.sessionId || h.sessionId === i.sessionId);
  const judged = Object.values(i.messageDecisions);
  return qs.map((q) => {
    const flagged = mine.filter((h) => h.flags.some((f) => f.questionId === q.id));
    const newest = flagged.reduce<Highlight | undefined>((m, h) => (!m || h.ts > m.ts ? h : m), undefined);
    const seen = judged.filter((d) => q.id in d.answers || d.fired.includes(q.id) || d.skipped?.includes(q.id));
    return {
      id: q.id, label: q.label, scope: q.scope, sources: q.sources, local: !!q.local, paused: !!i.rules.find((r) => r.id === q.ruleId)?.paused, muted: i.hidden.has(q.id),
      answer: last?.answers[q.id], fired: last?.fired.includes(q.id) ?? false, skipped: last?.skipped?.includes(q.id) ?? false, history: q.scope === "window" ? recent.map((d) => meterValue(d.answers[q.id])) : [],
      fires: flagged.length, lastFire: newest?.ts ?? null, last: newest,
      judged: seen.length, matched: seen.filter((d) => d.fired.includes(q.id)).length,
    };
  });
}

/** The latest avatar seen per handle in chat: gifts, follows and joins from older recordings carry none. */
export function avatarIndex(chat: ChatEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of chat) if (c.avatar) m.set(c.handle, c.avatar);
  return m;
}

export interface ViewerStats { current: number | null; peak: number; delta: number | null; trend: "up" | "down" | "flat" }
/** Current count, session peak and the change against ~5 minutes ago (or the oldest sample). */
export function viewerStats(series: { ts: number; count: number }[], now: number): ViewerStats {
  const last = series.at(-1);
  const current = last?.count ?? null;
  const peak = series.reduce((m, p) => Math.max(m, p.count), 0);
  const ref = [...series].reverse().find((p) => now - p.ts >= 5 * 60_000) ?? series[0];
  const delta = current !== null && ref && ref !== last ? current - ref.count : null;
  const trend = delta === null || Math.abs(delta) < Math.max(2, (ref?.count ?? 0) * 0.05) ? "flat" : delta > 0 ? "up" : "down";
  return { current, peak, delta, trend };
}

/** "5" → 300 s, "2:30" → 150 s, "45s" → 45 s; null when unreadable. */
export function parseCountdown(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const clock = t.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const secs = t.match(/^(\d+(?:\.\d+)?)\s*s(?:ec)?$/);
  if (secs) return Math.round(Number(secs[1]));
  const mins = t.match(/^(\d+(?:\.\d+)?)\s*(?:m|min)?$/);
  if (mins) return Math.round(Number(mins[1]) * 60);
  return null;
}
export const fmtCountdown = (sec: number) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
export const fmtElapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`; };

export interface NoteItem { key: string; text: string; checkable: boolean }
/** One item per non-empty line; "- ", "* ", "[ ] " or "[x] " prefixes make it a checkbox. */
export function parseNotes(text: string): NoteItem[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => { const m = l.match(/^(?:-|\*|\[ \]|\[x\])\s*(.*)$/i); return { key: `${i}:${l}`, text: m ? m[1] : l, checkable: !!m }; });
}

export const meterValue = (a?: JevAnswer) => (!a ? 0 : a.type === "noul" ? a.noul : a.type === "score" ? a.score / Math.max(1, Object.keys(a.legend).length - 1) : a.confidence);
export const meterText = (a?: JevAnswer, skipped = false) => (skipped ? t("na") : a ? answerShort(a) : "—");

export const VELOCITY_LEVEL: Record<string, number> = { silent: 0, quiet: 0.25, steady: 0.5, busy: 0.75, flood: 1 };
export const LIKES_LEVEL: Record<string, number> = { none: 0, few: 0.33, many: 0.66, burst: 1 };
