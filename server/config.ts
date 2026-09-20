import { Config, Effect } from "effect";

export const AppConfig = Effect.all({
  openrouterKey: Config.string("OPENROUTER_API_KEY"),
  deepgramKey: Config.string("DEEPGRAM_API_KEY"),
  tiktokUsername: Config.string("TIKTOK_USERNAME").pipe(Config.withDefault("")),
  tiktokSessionId: Config.string("TIKTOK_SESSION_ID").pipe(Config.withDefault("")),
  port: Config.integer("PORT").pipe(Config.withDefault(3001)),
  /** Path to a recorded .jsonl session to replay instead of connecting to TikTok. */
  replay: Config.string("REPLAY").pipe(Config.withDefault("")),
  jevModel: Config.string("JEV_MODEL").pipe(Config.withDefault("typesafe/jev-1.13")),
  glmModel: Config.string("GLM_MODEL").pipe(Config.withDefault("z-ai/glm-5.3-flash")),
  visionModel: Config.string("VISION_MODEL").pipe(Config.withDefault("z-ai/glm-4.6v")),
  tickMs: Config.integer("TICK_MS").pipe(Config.withDefault(1000)),
  captionEveryMs: Config.integer("CAPTION_EVERY_MS").pipe(Config.withDefault(6000)),
});
export type AppConfig = Effect.Effect.Success<typeof AppConfig>;
