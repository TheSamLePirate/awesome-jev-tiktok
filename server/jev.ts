import { Data, Effect, Schedule, Schema } from "effect";
import { SettingsStore } from "./settings";
import { Gate, GateError } from "./gate";
import type { JevAnswer, JevQuestion } from "../shared/protocol";

// Verified 2026-09-20: OpenRouter serves TypeSafe's decisions API at /api/alpha/decisions (the /api/v1 path 404s).
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
/** Reserved per call before it starts; reconciled with the provider's reported cost after. */
export const JEV_CALL_ESTIMATE_USD = 0.00003;

export class JevError extends Data.TaggedError("JevError")<{ status: number; body: string; retryable: boolean; kind?: GateError["kind"] }> {
  get message() { return this.kind ? `${this.kind}: ${this.body}` : `HTTP ${this.status} ${this.body.slice(0, 120)}`; }
}

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
  /** false when the provider did not report a cost and 0 is only a guess */
  costConfirmed: boolean;
  inputTokens: number;
  outputTokens: number;
}

export interface JevApi { decide: (state: unknown, questions: Record<string, JevQuestion>) => Effect.Effect<JevResult, JevError> }

/** One System One call: a state and a map of questions, all evaluated in parallel by jev. */
export class Jev extends Effect.Service<Jev>()("Jev", {
  effect: Effect.gen(function* () {
    const settings = yield* SettingsStore;
    const gate = yield* Gate;

    const once = (state: unknown, questions: Record<string, JevQuestion>): Effect.Effect<JevResult, JevError> =>
      Effect.gen(function* () {
        const started = performance.now();
        const st = yield* settings.get;
        yield* gate.admit(JEV_CALL_ESTIMATE_USD).pipe(Effect.mapError((e) => new JevError({ status: 0, body: e.message, retryable: false, kind: e.kind })));
        const res = yield* gate.fetchWithTimeout(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${st.keys.openrouter}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: st.models.jev, state, questions }),
        }, 6000).pipe(
          Effect.mapError((e) => new JevError({ status: 0, body: e.message, retryable: e.kind !== "timeout" ? true : false, kind: e.kind })),
          Effect.ensuring(gate.settle(JEV_CALL_ESTIMATE_USD)),
        );
        const text = yield* Effect.tryPromise({ try: () => res.text(), catch: (e) => new JevError({ status: res.status, body: String(e), retryable: true }) });
        if (!res.ok) {
          return yield* new JevError({ status: res.status, body: text.slice(0, 500), retryable: res.status === 429 || res.status >= 500 });
        }
        const parsed = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => new JevError({ status: res.status, body: "bad response: not JSON", retryable: false }) }).pipe(
          Effect.flatMap((j) => decode(j).pipe(Effect.mapError((e) => new JevError({ status: res.status, body: `bad response: ${e.message.slice(0, 200)}`, retryable: false })))),
        );
        return {
          answers: parsed.answers as Record<string, JevAnswer>,
          latencyMs: Math.round(performance.now() - started),
          cost: parsed.usage.cost ?? 0,
          costConfirmed: parsed.usage.cost !== undefined,
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens,
        };
      });

    // Retries only what can succeed on a retry (network, 5xx, 429 through the shared gate); a timeout is not retried
    // because the abandoned request may already be billed, and a 4xx / breaker / budget refusal never is.
    const decide = (state: unknown, questions: Record<string, JevQuestion>) =>
      once(state, questions).pipe(Effect.retry({ while: (e) => e.retryable, schedule: Schedule.exponential("300 millis").pipe(Schedule.intersect(Schedule.recurs(2))) }));

    return { decide } satisfies JevApi;
  }),
}) {}
