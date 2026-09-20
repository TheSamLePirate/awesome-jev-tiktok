import { Effect, Ref } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppConfig } from "./config";
import { MASK, type PublicSettings, type Settings } from "../shared/protocol";

const FILE = path.resolve("runtime", "settings.json");

/** Changing these only takes effect on the next stream connection (ffmpeg / Deepgram are started once per session). */
export const RECONNECT_FIELDS = ["tiktok.username", "tiktok.sessionId", "keys.deepgram", "models.deepgram", "models.language", "media.transcription", "media.hls", "media.frameWidth", "media.frameEverySec", "media.audioKeepAlive"];

export const defaultsFrom = (cfg: AppConfig): Settings => ({
  tiktok: { username: cfg.tiktokUsername, sessionId: cfg.tiktokSessionId },
  keys: { openrouter: cfg.openrouterKey, deepgram: cfg.deepgramKey },
  models: { jev: cfg.jevModel, glm: cfg.glmModel, vision: cfg.visionModel, deepgram: "nova-3", language: "multi" },
  timing: { tickMs: cfg.tickMs, captionEveryMs: cfg.captionEveryMs, highlightGapMs: 60_000, windowMs: 30_000, excerptMs: 20_000, toastMs: 4500 },
  decisions: { fireConfidenceFloor: 0.4, unsureBelow: 0.35, messageConcurrency: 4, judgeMessages: true },
  autoRefine: { enabled: true, emaBelow: 0.4, minSamples: 3, cooldownMs: 5 * 60_000, intervalMs: 20_000 },
  media: { transcription: true, vision: true, hls: true, frameWidth: 512, frameEverySec: 2, audioKeepAlive: true },
  glm: { temperature: 0.3, maxTokens: 4000 },
});

const SECTIONS = ["tiktok", "keys", "models", "timing", "decisions", "autoRefine", "media", "glm"] as const;

/** Deep-merge a partial patch over settings, section by section; masked secrets are left untouched. */
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
      else if (typeof cur === "boolean") next[sec][k] = Boolean(v);
      else if (typeof v === "string") next[sec][k] = v.trim();
    }
  }
  // Clamp to sane ranges so a typo cannot melt the rate limit or freeze the loop.
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  next.timing.tickMs = c(next.timing.tickMs, 250, 60_000);
  next.timing.captionEveryMs = c(next.timing.captionEveryMs, 1000, 600_000);
  next.timing.highlightGapMs = c(next.timing.highlightGapMs, 0, 3_600_000);
  next.timing.windowMs = c(next.timing.windowMs, 5_000, 180_000);
  next.timing.excerptMs = c(next.timing.excerptMs, 2_000, 120_000);
  next.timing.toastMs = c(next.timing.toastMs, 1000, 60_000);
  next.decisions.fireConfidenceFloor = c(next.decisions.fireConfidenceFloor, 0, 1);
  next.decisions.unsureBelow = c(next.decisions.unsureBelow, 0, 1);
  next.decisions.messageConcurrency = c(Math.round(next.decisions.messageConcurrency), 1, 16);
  next.autoRefine.emaBelow = c(next.autoRefine.emaBelow, 0, 1);
  next.autoRefine.minSamples = c(Math.round(next.autoRefine.minSamples), 1, 20);
  next.autoRefine.cooldownMs = c(next.autoRefine.cooldownMs, 10_000, 86_400_000);
  next.autoRefine.intervalMs = c(next.autoRefine.intervalMs, 5_000, 600_000);
  next.media.frameWidth = c(Math.round(next.media.frameWidth), 128, 1920);
  next.media.frameEverySec = c(next.media.frameEverySec, 0.5, 60);
  next.glm.temperature = c(next.glm.temperature, 0, 2);
  next.glm.maxTokens = c(Math.round(next.glm.maxTokens), 256, 32_000);
  return next as Settings;
};

const mask = (v: string) => (v ? `${MASK}${v.slice(-4)}` : "");

export const toPublic = (s: Settings, updatedAt: number): PublicSettings => ({
  ...s,
  tiktok: { username: s.tiktok.username, sessionId: mask(s.tiktok.sessionId) },
  keys: { openrouter: mask(s.keys.openrouter), deepgram: mask(s.keys.deepgram) },
  secrets: { openrouter: !!s.keys.openrouter, deepgram: !!s.keys.deepgram, tiktokSession: !!s.tiktok.sessionId },
  reconnectFields: RECONNECT_FIELDS,
  updatedAt,
});

/** Runtime settings: seeded from .env, overridden by runtime/settings.json, editable live from the UI. */
export class SettingsStore extends Effect.Service<SettingsStore>()("SettingsStore", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const defaults = defaultsFrom(cfg);
    const saved = yield* Effect.tryPromise(() => readFile(FILE, "utf8").then((t) => JSON.parse(t) as { settings: Partial<Settings>; updatedAt: number })).pipe(Effect.orElseSucceed(() => null));
    // Saved secrets win only when non-empty; otherwise the env value stays.
    const initial = saved ? applyPatch(defaults, saved.settings as any) : defaults;
    if (saved && !saved.settings.keys?.openrouter) initial.keys.openrouter = defaults.keys.openrouter;
    if (saved && !saved.settings.keys?.deepgram) initial.keys.deepgram = defaults.keys.deepgram;
    const ref = yield* Ref.make(initial);
    const updatedAt = yield* Ref.make(saved?.updatedAt ?? Date.now());
    if (saved) yield* Effect.logInfo(`settings: loaded overrides from ${FILE}`);

    const persist = Effect.gen(function* () {
      const s = yield* Ref.get(ref);
      const at = yield* Ref.get(updatedAt);
      yield* Effect.promise(async () => { await mkdir(path.dirname(FILE), { recursive: true }); await writeFile(FILE, JSON.stringify({ settings: s, updatedAt: at }, null, 1)); });
    }).pipe(Effect.ignore);

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
