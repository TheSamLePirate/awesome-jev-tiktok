import { Effect, Ref, Schema } from "effect";
import path from "node:path";
import { AppConfig } from "./config";
import { MASK, type PublicSettings, type Settings } from "../shared/protocol";
import { atomicWrite, readJson } from "./fs";

/** Resolved when the service is built (not at import) so tests can point it at a scratch directory. */
const settingsFile = () => path.join(process.env.JEV_RUNTIME_DIR ?? path.resolve("runtime"), "settings.json");

/** Changing these only takes effect on the next stream connection (ffmpeg / Deepgram are started once per session). */
export const RECONNECT_FIELDS = ["tiktok.username", "tiktok.sessionId", "keys.deepgram", "models.deepgram", "models.language", "media.transcription", "media.hls", "media.recordVideo", "media.frameWidth", "media.frameEverySec", "media.audioKeepAlive", "media.dvrMinutes"];

export const defaultsFrom = (cfg: AppConfig): Settings => ({
  tiktok: { username: cfg.tiktokUsername, sessionId: cfg.tiktokSessionId, autoConnect: false, resume: true, pollSec: 60 },
  keys: { openrouter: cfg.openrouterKey, deepgram: cfg.deepgramKey },
  models: { jev: cfg.jevModel, glm: cfg.glmModel, vision: cfg.visionModel, deepgram: "nova-3", language: "multi" },
  timing: { tickMs: cfg.tickMs, captionEveryMs: cfg.captionEveryMs, highlightGapMs: 60_000, windowMs: 30_000, excerptMs: 20_000, toastMs: 4500, maxTickGapMs: 15_000 },
  decisions: { fireConfidenceFloor: 0.4, unsureBelow: 0.35, messageConcurrency: 4, judgeMessages: true },
  budget: { sessionUsd: 2, chatPerMinute: 120, chatMaxAgeMs: 10_000, chatQueue: 200 },
  replay: { dryRun: false },
  // Off by default: a low confidence is not proof that the question is wrong, and a rewrite mid-live changes what fires.
  autoRefine: { enabled: false, emaBelow: 0.4, minSamples: 3, cooldownMs: 5 * 60_000, intervalMs: 20_000 },
  media: { transcription: true, vision: true, hls: true, recordVideo: true, frameWidth: 512, frameEverySec: 2, audioKeepAlive: true, dvrMinutes: 90 },
  glm: { temperature: 0.3, maxTokens: 4000 },
  assist: { sessionUsd: 0.5, autoResolve: true, dedupe: true, thanks: true, thanksMinDiamonds: 1, promises: true, faq: true, faqText: "", poll: true, regime: true, degrade: true, repair: true, ruleHygiene: true, retention: false, diskFloorGb: 5, interruptibility: true },
});

export const SECTIONS = ["tiktok", "keys", "models", "timing", "decisions", "budget", "replay", "autoRefine", "media", "glm", "assist"] as const;
export type Section = (typeof SECTIONS)[number];

/** Strings such as "false", "off" or "0" mean false: an HTML form or a JSON import may send them. */
export const toBool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") { const s = v.trim().toLowerCase(); if (["true", "on", "yes", "1"].includes(s)) return true; if (["false", "off", "no", "0", ""].includes(s)) return false; }
  return undefined;
};

/** Deep-merge a partial patch over settings, section by section; masked secrets are left untouched. Unknown keys are ignored. */
export const applyPatch = (base: Settings, patch: Partial<Record<string, unknown>>): Settings => {
  const next: any = structuredClone(base);
  for (const sec of SECTIONS) {
    const p = (patch as any)[sec];
    if (!p || typeof p !== "object") continue;
    for (const [k, v] of Object.entries(p)) {
      if (!(k in next[sec])) continue;
      if (typeof v === "string" && v.startsWith(MASK)) continue; // untouched secret
      const cur = next[sec][k];
      if (typeof cur === "number") { const n = Number(v); if (Number.isFinite(n)) next[sec][k] = n; }
      else if (typeof cur === "boolean") { const b = toBool(v); if (b !== undefined) next[sec][k] = b; }
      else if (typeof v === "string") next[sec][k] = v.trim();
    }
  }
  // Clamp to sane ranges so a typo cannot melt the rate limit or freeze the loop.
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  next.tiktok.pollSec = c(Math.round(next.tiktok.pollSec), 20, 600);
  next.timing.tickMs = c(next.timing.tickMs, 250, 60_000);
  next.timing.captionEveryMs = c(next.timing.captionEveryMs, 1000, 600_000);
  next.timing.highlightGapMs = c(next.timing.highlightGapMs, 0, 3_600_000);
  next.timing.windowMs = c(next.timing.windowMs, 5_000, 180_000);
  next.timing.excerptMs = c(next.timing.excerptMs, 2_000, 120_000);
  next.timing.toastMs = c(next.timing.toastMs, 1000, 60_000);
  next.timing.maxTickGapMs = c(next.timing.maxTickGapMs, 1000, 600_000);
  next.decisions.fireConfidenceFloor = c(next.decisions.fireConfidenceFloor, 0, 1);
  next.decisions.unsureBelow = c(next.decisions.unsureBelow, 0, 1);
  next.decisions.messageConcurrency = c(Math.round(next.decisions.messageConcurrency), 1, 16);
  next.budget.sessionUsd = c(next.budget.sessionUsd, 0, 1000);
  next.budget.chatPerMinute = c(Math.round(next.budget.chatPerMinute), 1, 5000);
  next.budget.chatMaxAgeMs = c(next.budget.chatMaxAgeMs, 1000, 120_000);
  next.budget.chatQueue = c(Math.round(next.budget.chatQueue), 10, 5000);
  next.autoRefine.emaBelow = c(next.autoRefine.emaBelow, 0, 1);
  next.autoRefine.minSamples = c(Math.round(next.autoRefine.minSamples), 1, 20);
  next.autoRefine.cooldownMs = c(next.autoRefine.cooldownMs, 10_000, 86_400_000);
  next.autoRefine.intervalMs = c(next.autoRefine.intervalMs, 5_000, 600_000);
  next.media.frameWidth = c(Math.round(next.media.frameWidth), 128, 1920);
  next.media.frameEverySec = c(next.media.frameEverySec, 0.5, 60);
  next.media.dvrMinutes = c(Math.round(next.media.dvrMinutes), 5, 720);
  next.glm.temperature = c(next.glm.temperature, 0, 2);
  next.glm.maxTokens = c(Math.round(next.glm.maxTokens), 256, 32_000);
  next.assist.sessionUsd = c(next.assist.sessionUsd, 0, 100);
  next.assist.thanksMinDiamonds = c(Math.round(next.assist.thanksMinDiamonds), 0, 100_000);
  next.assist.diskFloorGb = c(next.assist.diskFloorGb, 1, 500);
  next.assist.faqText = String(next.assist.faqText).slice(0, 20_000);
  return next as Settings;
};

const mask = (v: string) => (v ? `${MASK}${v.slice(-4)}` : "");

export const toPublic = (s: Settings, updatedAt: number): PublicSettings => ({
  ...s,
  tiktok: { ...s.tiktok, sessionId: mask(s.tiktok.sessionId) },
  keys: { openrouter: mask(s.keys.openrouter), deepgram: mask(s.keys.deepgram) },
  secrets: { openrouter: !!s.keys.openrouter, deepgram: !!s.keys.deepgram, tiktokSession: !!s.tiktok.sessionId },
  reconnectFields: RECONNECT_FIELDS,
  updatedAt,
});

/** The on-disk shape is loose on purpose: any subset of sections, validated field by field by `applyPatch`. */
const SavedSchema = Schema.Struct({ settings: Schema.Record({ key: Schema.String, value: Schema.Unknown }), updatedAt: Schema.optionalWith(Schema.Number, { default: () => Date.now() }) });

/** Runtime settings: seeded from .env, overridden by runtime/settings.json, editable live from the UI. */
export class SettingsStore extends Effect.Service<SettingsStore>()("SettingsStore", {
  effect: Effect.gen(function* () {
    const FILE = settingsFile();
    const cfg = yield* AppConfig;
    const defaults = defaultsFrom(cfg);
    const saved = yield* readJson(FILE, SavedSchema).pipe(
      Effect.tapError((e) => Effect.logWarning(`settings: ${e.message}; using .env defaults`)),
      Effect.orElseSucceed(() => null),
      Effect.map((o) => (o && o._tag === "Some" ? o.value : null)),
    );
    const initial = saved ? applyPatch(defaults, saved.settings as any) : defaults;
    const ref = yield* Ref.make(initial);
    const updatedAt = yield* Ref.make(saved?.updatedAt ?? Date.now());
    if (saved) yield* Effect.logInfo(`settings: loaded overrides from ${FILE}`);

    /**
     * Persist only what differs from the .env defaults. Secrets equal to the environment are never written to disk,
     * and the file is created with mode 0600 through an atomic rename.
     */
    const persist = Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      const at = yield* Ref.get(updatedAt);
      const diff: Record<string, Record<string, unknown>> = {};
      for (const sec of SECTIONS) for (const [k, v] of Object.entries(s[sec])) if ((defaults as any)[sec][k] !== v) (diff[sec] ??= {})[k] = v;
      yield* atomicWrite(FILE, JSON.stringify({ settings: diff, updatedAt: at }, null, 1), 0o600);
    }).pipe(Effect.tapError((e) => Effect.logError(`settings: could not persist: ${e.message}`)), Effect.ignore);

    return {
      get: Ref.get(ref),
      public: Effect.gen(function* () { return toPublic(yield* Ref.get(ref), yield* Ref.get(updatedAt)); }),
      update: (patch: Partial<Record<string, unknown>>) =>
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(ref, (cur) => applyPatch(cur, patch));
          const at = yield* Ref.updateAndGet(updatedAt, () => Date.now());
          yield* persist;
          return toPublic(next, at);
        }),
      reset: Effect.gen(function* () {
        yield* Ref.set(ref, defaults);
        const at = yield* Ref.updateAndGet(updatedAt, () => Date.now());
        yield* persist;
        return toPublic(defaults, at);
      }),
    };
  }),
}) {}
