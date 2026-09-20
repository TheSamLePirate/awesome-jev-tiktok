import { Data, Duration, Effect, ParseResult, Schedule, Schema } from "effect";
import { AppConfig } from "./config";
import type { FeedbackRequest, JevQuestion, Rule, Source, WatchQuestion } from "../shared/protocol";

export class GlmError extends Data.TaggedError("GlmError")<{ message: string }> {}

// ---- schema for what GLM must return ----
const Json: Schema.Schema<unknown> = Schema.Unknown;
const NoulQ = Schema.Struct({ type: Schema.Literal("noul"), instructions: Json, criteria: Schema.optional(Schema.Struct({ true: Schema.optional(Json), false: Schema.optional(Json) })) });
const ChoiceQ = Schema.Struct({ type: Schema.Literal("choice"), instructions: Json, criteria: Schema.Record({ key: Schema.String, value: Json }) });
const ScoreQ = Schema.Struct({ type: Schema.Literal("score"), instructions: Json, criteria: Schema.Array(Json).pipe(Schema.minItems(2), Schema.maxItems(10)) });
const Alert = Schema.Struct({ noulAbove: Schema.optional(Schema.Number), choices: Schema.optional(Schema.Array(Schema.String)), scoreAtLeast: Schema.optional(Schema.Number) });
const GlmQuestion = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]{1,40}$/)),
  label: Schema.String,
  scope: Schema.Literal("window", "message"),
  question: Schema.Union(NoulQ, ChoiceQ, ScoreQ),
  alert: Schema.optional(Alert),
});
const CompileOut = Schema.Struct({ questions: Schema.Array(GlmQuestion).pipe(Schema.minItems(1), Schema.maxItems(5)) });
const RefineOut = Schema.Struct({ question: GlmQuestion, rationale: Schema.optionalWith(Schema.String, { default: () => "rewritten" }) });

const describe = (e: ParseResult.ParseError) => ParseResult.ArrayFormatter.formatErrorSync(e).slice(0, 3).map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ");

const SYSTEM = `You write questions for TypeSafe "jev", a System One decision model. jev does not generate text: it answers typed questions about a JSON state and returns calibrated probabilities. You must output ONLY JSON.

Question types:
- noul: yes/no -> probability. Fields: instructions (a direct question), optional criteria {true: "...", false: "..."} that pin down the boundary.
- choice: pick one option. Fields: instructions, criteria: object mapping option_key -> description of what it covers (and does NOT cover). 2-12 options. Keys are snake_case.
- score: ordered levels. Fields: instructions, criteria: array of 2-10 level descriptions from lowest to highest; the answer is a float index (0 = first level).

Rules for good jev questions (from TypeSafe's jaggedness notes):
- Ask exactly what you mean, literally. No double negatives, no multi-hop reasoning, no arithmetic, no counting, no date math.
- State fields are pre-bucketed words (e.g. chat_velocity: "busy"); refer to them by name when relevant.
- Keep instructions short. Put the nuance in criteria descriptions with concrete examples.
- Write in English even if the stream is in another language; jev reads other languages.

Each rule reads a subset of media sources, and jev only sees the state for those sources. Field names by source:
- transcript -> host_speech_last_30s: string (what the host said, speech-to-text)
- video -> video_scene: string[] (one or two vision captions of the latest video frames)
- chat -> chat_recent: [{handle, text, secs_ago}], activity.chat_velocity (silent|quiet|steady|busy|flood), activity.new_joins_last_30s
- always -> activity: { viewers: number, viewers_trend: falling|flat|rising, likes_last_30s: none|few|many|burst, gifts_last_60s: string[] }

Scope "window" state (updated every second) = the fields above for the rule's sources.
Scope "message" state (one call per new chat message, only allowed when "chat" is among the sources) = { message: {handle, nickname, text}, context: { previous_chat, host_speech_last_30s?, video_scene? } }.

Pick scope "message" when the rule is about individual chat messages, "window" when it is about the room, the host, the video, or trends. Refer to fields by the exact names above.

Each question object: { id: snake_case unique, label: short UI label (<= 3 words), scope, question: {type, instructions, criteria}, alert?: {noulAbove?: 0-1, choices?: [keys], scoreAtLeast?: index} } where alert describes when the UI should light up.`;

/** GLM writes and rewrites jev question sets. Never on the hot path; only when rules change or answers look wrong. */
export class Glm extends Effect.Service<Glm>()("Glm", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig;

    const chat = (messages: { role: "system" | "user"; content: string }[]) =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${cfg.openrouterKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: cfg.glmModel, messages, response_format: { type: "json_object" }, temperature: 0.3, max_tokens: 4000 }),
            }),
          catch: (e) => new GlmError({ message: String(e) }),
        });
        const json: any = yield* Effect.tryPromise({ try: () => res.json(), catch: (e) => new GlmError({ message: String(e) }) });
        if (!res.ok) return yield* new GlmError({ message: `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}` });
        const content: string = json.choices?.[0]?.message?.content ?? "";
        const tokens: number = json.usage?.total_tokens ?? 0;
        const usage = { inputTokens: Number(json.usage?.prompt_tokens ?? 0), outputTokens: Number(json.usage?.completion_tokens ?? 0), cost: Number(json.usage?.cost ?? 0) };
        // Strip code fences if the model added them despite json mode.
        const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
        const parsed = yield* Effect.try({ try: () => JSON.parse(cleaned) as unknown, catch: () => new GlmError({ message: `GLM returned non-JSON: ${cleaned.slice(0, 200)}` }) });
        return { parsed, tokens, usage };
      }).pipe(
        Effect.timeoutFail({ duration: Duration.seconds(60), onTimeout: () => new GlmError({ message: "GLM timeout" }) }),
        Effect.retry({ schedule: Schedule.recurs(1) }),
      );

    const toWatch = (q: Schema.Schema.Type<typeof GlmQuestion>, ruleId: string, sources: Source[]): WatchQuestion => ({
      id: q.id, label: q.label, ruleId, scope: q.scope === "message" && !sources.includes("chat") ? "window" : q.scope, sources, question: q.question as JevQuestion,
      alert: q.alert ? { noulAbove: q.alert.noulAbove, choices: q.alert.choices ? [...q.alert.choices] : undefined, scoreAtLeast: q.alert.scoreAtLeast } : undefined,
    });

    /** Turn one plain-language rule into 1-5 jev questions. */
    const compileRule = (rule: Rule, existing: WatchQuestion[]) =>
      Effect.gen(function* () {
        const t0 = performance.now();
        const { parsed, tokens, usage } = yield* chat([
          { role: "system", content: SYSTEM },
          { role: "user", content: `Existing question ids (do not reuse): ${existing.map((q) => q.id).join(", ") || "none"}.\n\nThis rule reads these media sources: ${rule.sources.join(", ")}. Only reference state fields those sources provide.\n\nWrite the jev question(s) that implement this rule from the streamer's operator:\n"""${rule.text}"""\n\nReturn {"questions": [...]}. Prefer one question; add more only if the rule clearly has several independent parts.` },
        ]);
        const out = yield* Schema.decodeUnknown(CompileOut)(parsed).pipe(Effect.mapError((e) => new GlmError({ message: `GLM output failed validation: ${describe(e)} · raw: ${JSON.stringify(parsed).slice(0, 400)}` })));
        const taken = new Set(existing.map((q) => q.id));
        const questions = out.questions.map((q) => toWatch(q, rule.id, rule.sources)).map((q) => (taken.has(q.id) ? { ...q, id: `${q.id}_${rule.id.slice(-4)}` } : q));
        return { questions, tokens, usage, latencyMs: Math.round(performance.now() - t0) };
      });

    /** Rewrite one question given a disagreement (human feedback) or a pile of low-confidence samples. */
    const refine = (q: WatchQuestion, rule: Rule | undefined, evidence: { feedback?: FeedbackRequest[]; lowConfidence?: unknown[] }) =>
      Effect.gen(function* () {
        const t0 = performance.now();
        const { parsed, tokens, usage } = yield* chat([
          { role: "system", content: SYSTEM },
          { role: "user", content: `This jev question is not performing well. Rewrite it (keep the same id and scope, you may change the type only if clearly better).\n\nRule it implements: """${rule?.text ?? "unknown"}""" (sources: ${q.sources.join(", ")}; only reference fields those sources provide)\n\nCurrent question:\n${JSON.stringify(q, null, 2)}\n\n${evidence.feedback?.length ? `Human disagreed with these answers (state excerpt, jev's answer, note):\n${JSON.stringify(evidence.feedback, null, 1).slice(0, 6000)}\n` : ""}${evidence.lowConfidence?.length ? `jev was uncertain on these states:\n${JSON.stringify(evidence.lowConfidence, null, 1).slice(0, 6000)}\n` : ""}\nMake instructions more literal and criteria more concrete with examples so jev is decisive and agrees with the human. Return exactly {"question": {"id": "...", "label": "...", "scope": "...", "question": {"type": ..., "instructions": ..., "criteria": ...}, "alert": {...}}, "rationale": "one sentence"} — the same wrapped shape as the current question above.` },
        ]);
        // GLM sometimes returns the bare jev question instead of the wrapped object; normalise before validating.
        const raw: any = parsed;
        const normalised = raw && raw.question && typeof raw.question.type === "string" && !raw.question.question
          ? { ...raw, question: { id: q.id, label: raw.label ?? q.label, scope: q.scope, question: raw.question, alert: raw.alert ?? q.alert } }
          : raw && raw.question ? { ...raw, question: { id: q.id, scope: q.scope, ...raw.question } } : raw;
        const out = yield* Schema.decodeUnknown(RefineOut)(normalised).pipe(Effect.mapError((e) => new GlmError({ message: `GLM output failed validation: ${describe(e)} · raw: ${JSON.stringify(parsed).slice(0, 400)}` })));
        return { question: { ...toWatch(out.question, q.ruleId, q.sources), id: q.id, scope: q.scope }, rationale: out.rationale, tokens, usage, latencyMs: Math.round(performance.now() - t0) };
      });

    return { compileRule, refine };
  }),
}) {}
