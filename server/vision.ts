import { Data, Duration, Effect } from "effect";
import { AppConfig } from "./config";

export class VisionError extends Data.TaggedError("VisionError")<{ message: string }> {}

/** One or two sentences about a video frame, so jev can reason about the picture as text. */
export interface CaptionResult { text: string; latencyMs: number; inputTokens: number; outputTokens: number; cost: number }

export const captionFrame = (jpeg: Uint8Array, previous: string | undefined) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const t0 = performance.now();
    const b64 = Buffer.from(jpeg).toString("base64");
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.openrouterKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: cfg.visionModel,
            max_tokens: 120,
            reasoning: { enabled: false },
            messages: [{
              role: "user",
              content: [
                { type: "text", text: `This is a frame from a TikTok live. In at most 2 short sentences describe: who is on screen and what they are doing, the setting, visible on-screen text, and mood. Be literal, no speculation. Always give the full description even if nothing changed.${previous ? ` For consistency, the previous frame was described as: "${previous}".` : ""}` },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            }],
          }),
        }),
      catch: (e) => new VisionError({ message: String(e) }),
    });
    const json: any = yield* Effect.tryPromise({ try: () => res.json(), catch: (e) => new VisionError({ message: String(e) }) });
    if (!res.ok) return yield* new VisionError({ message: `HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}` });
    const text = String(json.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return yield* new VisionError({ message: "empty caption" });
    const result: CaptionResult = { text, latencyMs: Math.round(performance.now() - t0), inputTokens: Number(json.usage?.prompt_tokens ?? 0), outputTokens: Number(json.usage?.completion_tokens ?? 0), cost: Number(json.usage?.cost ?? 0) };
    return result;
  }).pipe(Effect.timeoutFail({ duration: Duration.seconds(20), onTimeout: () => new VisionError({ message: "timeout" }) }));
