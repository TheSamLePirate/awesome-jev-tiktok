// Factories for protocol objects: sensible defaults, override what the test cares about.
import type { ChatEvent, CostTotals, Decision, GlmActivity, HealthInfo, Highlight, LogEntry, MessageDecision, PublicSettings, QuestionSet, RecordingInfo, ReplayInfo, Rule, ServerMessage, SessionSummary, SessionTimeline, Snapshot, StreamStatusEvent, WatchQuestion } from "@shared/protocol";
import { PROTOCOL_VERSION, type WatchState, type PollState, type AssistState } from "@shared/protocol";
import { act } from "@testing-library/react";
import { dispatch } from "../lib/store";

export const T0 = 1_800_000_000_000;

export const question = (o: Partial<WatchQuestion> = {}): WatchQuestion => ({ id: "q1", label: "Host topic", ruleId: "r1", scope: "window", sources: ["transcript"], question: { type: "noul", instructions: "Is the host talking about politics?", criteria: { true: "yes", false: "no" } }, alert: { noulAbove: 0.7 }, ...o });
export const choiceQ = (o: Partial<WatchQuestion> = {}): WatchQuestion => question({ id: "q2", label: "Mood", sources: ["chat", "transcript"], question: { type: "choice", instructions: "Mood?", criteria: { fun: "jokes", focused: "serious", tense: "arguing", bored: "flat" } }, alert: { choices: ["tense"] }, ...o });
export const scoreQ = (o: Partial<WatchQuestion> = {}): WatchQuestion => question({ id: "q3", label: "Hype", sources: ["transcript", "video", "chat"], question: { type: "score", instructions: "How hyped?", criteria: ["Flat: calm", "Warm: steady", "Hot: fast", "On fire: flood"] }, alert: { scoreAtLeast: 2 }, ...o });
export const messageQ = (o: Partial<WatchQuestion> = {}): WatchQuestion => question({ id: "m1", label: "Question to host", ruleId: "r2", scope: "message", sources: ["chat"], question: { type: "noul", instructions: "Is this a question to the host?" }, ...o });
export const localQ = (o: Partial<WatchQuestion> = {}): WatchQuestion => question({ id: "k1", label: "links", ruleId: "r3", scope: "message", sources: ["chat"], question: { type: "noul", instructions: "Messages with a link" }, local: { pattern: "https?://", flags: "i" }, alert: { noulAbove: 0.5 }, ...o });

export const rule = (o: Partial<Rule> = {}): Rule => ({ id: "r1", text: "Tell me when the host talks about politics.", sources: ["transcript"], createdAt: T0, ...o });
export const qset = (qs: WatchQuestion[] = [question(), choiceQ(), scoreQ(), messageQ(), localQ()], o: Partial<QuestionSet> = {}): QuestionSet => ({ version: 3, createdAt: T0, reason: "rule added: politics", questions: qs, ...o });

export const decision = (o: Partial<Decision> = {}): Decision => ({ tick: 1, ts: T0 + 1000, version: 3, latencyMs: 320, cost: 0.0001, answers: { q1: { type: "noul", noul: 0.82 }, q2: { type: "choice", choice: "focused", probabilities: { focused: 0.6, fun: 0.2, tense: 0.15, bored: 0.05 }, confidence: 0.6 }, q3: { type: "score", score: 1.4, legend: { "0": "Flat: calm", "1": "Warm: steady", "2": "Hot: fast", "3": "On fire: flood" }, probabilities: { "0": 0.1, "1": 0.5, "2": 0.3, "3": 0.1 }, confidence: 0.5 } }, fired: ["q1"], ...o });
export const messageDecision = (o: Partial<MessageDecision> = {}): MessageDecision => ({ messageId: "c1", version: 3, latencyMs: 200, answers: { m1: { type: "noul", noul: 0.9 } }, fired: ["m1"], ...o });

export const chat = (o: Partial<ChatEvent> = {}): ChatEvent => ({ kind: "chat", id: "c1", ts: T0 + 500, userId: "u1", handle: "alice", nickname: "Alice", text: "Hello host, what time is it?", avatar: "https://example.test/a.png", ...o });

export const highlight = (o: Partial<Highlight> = {}): Highlight => ({ id: "h1", ts: T0 + 2000, kind: "message", flags: [{ questionId: "m1", ruleId: "r2", label: "Question to host", sources: ["chat"], answer: { type: "noul", noul: 0.9 } }], message: chat(), pinned: false, resolved: false, sessionId: "s1", version: 3, severity: "info", evidence: { message: "Hello host" }, ...o });
export const transcriptHl = (o: Partial<Highlight> = {}): Highlight => highlight({ id: "h2", kind: "transcript", flags: [{ questionId: "q1", ruleId: "r1", label: "Host topic", sources: ["transcript"], answer: { type: "noul", noul: 0.82 } }], message: undefined, transcript: { from: T0, to: T0 + 4000, lines: [{ ts: T0 + 1000, text: "Let us talk about the election." }, { ts: T0 + 3000, text: "Politics again." }] }, ...o });
export const sceneHl = (o: Partial<Highlight> = {}): Highlight => highlight({ id: "h3", kind: "scene", flags: [{ questionId: "q4", ruleId: "r4", label: "Off camera", sources: ["video"], answer: { type: "choice", choice: "empty", probabilities: { empty: 0.9 }, confidence: 0.9 } }], message: undefined, scene: { ts: T0 + 2000, text: "An empty chair." }, severity: "warn", ...o });
export const roomHl = (o: Partial<Highlight> = {}): Highlight => highlight({ id: "h4", kind: "room", flags: [{ questionId: "q3", ruleId: "r1", label: "Hype", sources: ["transcript", "video", "chat"], answer: { type: "score", score: 2, legend: { "0": "Flat", "1": "Warm", "2": "Hot", "3": "On fire" }, probabilities: { "2": 0.8 }, confidence: 0.8 } }], message: undefined, chat: [{ handle: "bob", text: "wow", secs_ago: 3 }], activity: { chat_velocity: "busy", viewers: 120, viewers_trend: "rising", likes_last_30s: "many", gifts_last_60s: [], new_joins_last_30s: "few" }, ...o });

export const logEntry = (o: Partial<LogEntry> = {}): LogEntry => ({ id: "l1", ts: T0 + 1000, actor: "jev", kind: "tick", detail: "3 questions", ok: true, latencyMs: 300, inputTokens: 500, outputTokens: 40, cost: 0.0002, costKind: "confirmed", questions: 3, sessionId: "s1", ...o });
export const totals = (o: Partial<CostTotals> = {}): CostTotals => ({ session: 0.012, boot: 0.03, byActor: { jev: 0.008, glm: 0.002, vision: 0.001, deepgram: 0.001, system: 0 }, estimated: 0.001, reserved: 0, ...o });
export const health = (o: Partial<HealthInfo> = {}): HealthInfo => ({ ffmpeg: "running", recorder: "running", deepgram: "open", lastTickAt: T0, chatBacklog: 0, chatDropped: 0, breaker: null, rateLimitedUntil: 0, budget: { spent: 0.01, cap: 2, stopped: false }, diskFreeBytes: 50e9, ...o });
export const glm = (o: Partial<GlmActivity> = {}): GlmActivity => ({ id: "g1", ts: T0, kind: "compile", status: "done", summary: "wrote 2 questions", tokens: 800, ...o });

export const settings = (o: Partial<PublicSettings> = {}): PublicSettings => ({
  tiktok: { username: "koursk1", sessionId: "••••1234", autoConnect: false, resume: true, pollSec: 60 }, keys: { openrouter: "••••abcd", deepgram: "" }, secrets: { openrouter: true, deepgram: false, tiktokSession: true },
  models: { jev: "typesafe/jev-1.13", glm: "z-ai/glm-5.3-flash", vision: "z-ai/glm-4.6v", deepgram: "nova-3", language: "multi" },
  timing: { tickMs: 1000, captionEveryMs: 6000, highlightGapMs: 60_000, windowMs: 30_000, excerptMs: 20_000, toastMs: 4500, maxTickGapMs: 15_000 },
  decisions: { fireConfidenceFloor: 0.4, unsureBelow: 0.35, messageConcurrency: 4, judgeMessages: true },
  budget: { sessionUsd: 2, chatPerMinute: 120, chatMaxAgeMs: 10_000, chatQueue: 200 }, replay: { dryRun: false },
  autoRefine: { enabled: false, emaBelow: 0.4, minSamples: 3, cooldownMs: 300_000, intervalMs: 20_000 },
  media: { transcription: true, vision: true, hls: true, recordVideo: true, frameWidth: 512, frameEverySec: 2, audioKeepAlive: true, dvrMinutes: 90 },
  assist: { sessionUsd: 0.5, autoResolve: true, dedupe: true, thanks: true, thanksMinDiamonds: 1, promises: true, faq: true, faqText: "", poll: true, regime: true, degrade: true, repair: true, ruleHygiene: true, retention: false, diskFloorGb: 5, interruptibility: true },
  glm: { temperature: 0.3, maxTokens: 4000 }, reconnectFields: ["tiktok.username", "media.hls"], updatedAt: T0, ...o,
});

export const snapshot = (o: Partial<Snapshot> = {}): Snapshot => ({ ts: T0, transcript_last_30s: "hello everyone", scene: ["a desk"], chat_recent: [{ handle: "alice", text: "hi", secs_ago: 2 }], activity: { chat_velocity: "steady", viewers: 67, viewers_trend: "flat", likes_last_30s: "few", gifts_last_60s: [], new_joins_last_30s: "few" }, sources: { transcript: { state: "available", ageMs: 500 }, video: { state: "available", ageMs: 1000 }, chat: { state: "available", ageMs: 100 } }, ...o });
export const status = (o: Partial<StreamStatusEvent> = {}): StreamStatusEvent => ({ kind: "stream", ts: T0, state: "live", username: "koursk1", title: "Débat du soir", ...o });
export const summary = (o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: "s1", username: "koursk1", title: "Débat", startedAt: T0, endedAt: T0 + 90_000, reason: "stream ended", highlights: 4, warnings: 1, spend: 0.02, peakViewers: 80, chatCount: 40, transcriptCount: 30, topFired: [{ id: "q1", label: "Host topic", count: 3 }], recording: "rec-1", ...o });
export const recording = (o: Partial<RecordingInfo> = {}): RecordingInfo => ({ id: "rec-1", events: "recordings/rec-1.jsonl", username: "koursk1", title: "Débat", createdAt: T0, durationSec: 754, sizeBytes: 26_000_000, eventCount: 427, chatCount: 126, transcriptCount: 156, videos: [{ file: "rec-1.mp4", startTs: T0 + 3000, endTs: T0 + 700_000, sizeBytes: 26_000_000, durationSec: 697 }], ...o });
export const replayInfo = (o: Partial<ReplayInfo> = {}): ReplayInfo => ({ id: "rec-1", username: "koursk1", title: "Débat", t0: T0, tEnd: T0 + 600_000, startedAt: Date.now() - 5000, offsetMs: 0, buckets: [{ chat: 3, transcript: 1 }, { chat: 0, transcript: 4 }, { chat: 6, transcript: 2 }], bucketMs: 200_000, segments: [{ url: "/recordings/rec-1.mp4", startTs: T0 + 3000, endTs: T0 + 500_000 }], dryRun: true, ...o });
export const timeline = (o: Partial<SessionTimeline> = {}): SessionTimeline => ({ startTs: Date.now() - 300_000, endTs: Date.now(), buckets: [{ chat: 2, transcript: 2 }, { chat: 5, transcript: 0 }], bucketMs: 150_000, segments: [{ url: "/hls/live.m3u8", startTs: Date.now() - 200_000, endTs: Date.now() }], dvrStartTs: Date.now() - 200_000, ...o });

export const assistState = (o: Partial<AssistState> = {}): AssistState => ({ regime: null, degrade: 0, budgetAlert: false, interruptible: null, repair: null, ruleAdvice: {}, spent: 0, at: T0, ...o });
export const poll = (o: Partial<PollState> = {}): PollState => ({ id: "p1", question: "Pizza or burger?", options: ["pizza", "burger"], startedAt: T0, endedAt: null, counts: { pizza: 3, burger: 1 }, voters: 4, judged: 6, recent: [{ handle: "amy", nickname: "Amy", avatar: "https://example.test/a.png", option: "pizza", ts: T0 + 1000 }, { handle: "bob", nickname: "Bob", option: "burger", ts: T0 + 2000 }], ...o });
export const watchState = (o: Partial<WatchState> = {}): WatchState => ({ armed: false, username: "koursk1", since: null, lastCheck: null, nextCheck: null, lastResult: null, checks: 0, ...o });
export const hello = (o: Partial<Extract<ServerMessage, { type: "hello" }>> = {}): ServerMessage => ({
  type: "hello", seq: 1, status: status(), questions: qset(), history: [qset([question()], { version: 1, reason: "seed" }), qset([question(), choiceQ()], { version: 2, reason: "rule added: mood" }), qset()], rules: [rule(), rule({ id: "r2", text: "Flag questions to the host", sources: ["chat"] }), rule({ id: "r3", text: "links", sources: ["chat"], kind: "keyword", paused: true })],
  recent: [chat(), chat({ id: "c2", ts: T0 + 900, text: "second message" }), { kind: "transcript", ts: T0 + 1000, text: "Let us talk about the election.", final: true }, { kind: "caption", ts: T0 + 1200, text: "A person at a desk." }, { kind: "viewers", ts: T0 + 1300, count: 67 }, { kind: "member", ts: T0 + 1400, handle: "bob", nickname: "Bob" }],
  decisions: [decision()], messageDecisions: [messageDecision()], glm: [glm()], highlights: [highlight(), transcriptHl(), sceneHl({ resolved: true }), roomHl({ pinned: true })], log: [logEntry()], settings: settings(), video: null, recording: { active: false, segments: 0, finalizing: false }, replay: null, totals: totals(), health: health(), summary: null, sessionId: "s1", watch: watchState(), poll: null, assist: assistState(), protocol: PROTOCOL_VERSION, ...o,
});

/** A server message without its sequence number (distributive over the union, so each variant keeps its own fields). */
export type Body = ServerMessage extends infer M ? (M extends ServerMessage ? Omit<M, "seq"> : never) : never;

/** Feed the store a message inside act(), so components subscribed through useStore re-render synchronously. */
export const send = (msg: ServerMessage) => act(() => dispatch({ type: "ws", msg }));
let seq = 100;
export const push = (body: Body) => send({ ...body, seq: ++seq } as ServerMessage);
