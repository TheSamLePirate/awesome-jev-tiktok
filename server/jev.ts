import { Data, Duration, Effect, Schedule, Schema } from "effect";
import { AppConfig } from "./config";
import type { JevAnswer, JevQuestion } from "../shared/protocol";

// Verified 2026-09-20: OpenRouter serves TypeSafe's decisions API at /api/alpha/decisions (the /api/v1 path 404s).
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

export class JevError extends Data.TaggedError("JevError")<{ status: number; body: string; retryable: boolean }> {}

const NoulAnswer = Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number });
const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record({ key: Schema.String, value: Schema.Number }),
  confidence: Schema.Number,
});
const ScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Number,
  legend: Schema.Record({ key: Schema.String, value: Schema.String }),
  probabilities: Schema.Record({ key: Schema.String, value: Schema.Number }),
  confidence: Schema.Number,
});
const DecisionsResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record({ key: Schema.String, value: Schema.Union(NoulAnswer, ChoiceAnswer, ScoreAnswer) }),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number, cost: Schema.optional(Schema.Number) }),
});
const decode = Schema.decodeUnknown(DecisionsResponse);

export interface JevResult {
  answers: Record<string, JevAnswer>;
  latencyMs: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

/** One System One call: a state and a map of questions, all evaluated in parallel by jev. */
export class Jev extends Effect.Service<Jev>()("Jev", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig;

    const decide = (state: unknown, questions: Record<string, JevQuestion>): Effect.Effect<JevResult, JevError> =>
      Effect.gen(function* () {
        const started = performance.now();
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(ENDPOINT, {
              method: "POST",
              headers: { Authorization: `Bearer ${cfg.openrouterKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: cfg.jevModel, state, questions }),
            }),
          catch: (e) => new JevError({ status: 0, body: String(e), retryable: true }),
        });
        const text = yield* Effect.promise(() => res.text());
        if (!res.ok) {
          return yield* new JevError({ status: res.status, body: text.slice(0, 500), retryable: res.status === 429 || res.status >= 500 });
        }
        const parsed = yield* decode(JSON.parse(text)).pipe(
          Effect.mapError((e) => new JevError({ status: res.status, body: `bad response: ${e.message}`, retryable: false })),
        );
        return {
          answers: parsed.answers as Record<string, JevAnswer>,
          latencyMs: Math.round(performance.now() - started),
          cost: parsed.usage.cost ?? 0,
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens,
        };
      }).pipe(
        Effect.timeoutFail({ duration: Duration.seconds(6), onTimeout: () => new JevError({ status: 0, body: "timeout", retryable: true }) }),
        Effect.retry({ while: (e) => e.retryable, schedule: Schedule.exponential("300 millis").pipe(Schedule.intersect(Schedule.recurs(2))) }),
      );

    return { decide };
  }),
}) {}
