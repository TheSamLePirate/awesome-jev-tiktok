// Types shared between the Bun server and the React UI.

// ---------- jev question / answer shapes (TypeSafe System One) ----------
export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

// ---------- question sets (what GLM writes, what jev runs) ----------
/** "window" questions look at the last ~30s of everything; "message" questions judge one chat message. */
export type QuestionScope = "window" | "message";

/** Which media a rule/question reads. jev only sees the projected state for these sources. */
export type Source = "transcript" | "video" | "chat";
export const ALL_SOURCES: readonly Source[] = ["transcript", "video", "chat"];

export interface WatchQuestion {
  id: string;
  /** Human label shown on the gauge. */
  label: string;
  /** The plain-language rule the user typed that this question implements. */
  ruleId: string;
  scope: QuestionScope;
  sources: Source[];
  question: JevQuestion;
  /** Optional: which answer values should light up the gauge (for the UI and the "fire" flag). */
  alert?: { noulAbove?: number; choices?: string[]; scoreAtLeast?: number };
  /**
   * A local matcher (keyword / regex) evaluated in-process, never sent to jev. The answer is a noul of 1 (match) or 0.
   * `flags` are JavaScript RegExp flags; the pattern is validated when the rule is created.
   */
  local?: { pattern: string; flags?: string };
}

export type RuleKind = "jev" | "keyword";

export interface Rule {
  id: string;
  text: string;
  sources: Source[];
  createdAt: number;
  /** "keyword" rules run locally and cost nothing; "jev" rules are compiled by GLM into jev questions. */
  kind?: RuleKind;
  /** A paused rule keeps its questions but the server skips them (no jev call, no alert). */
  paused?: boolean;
}

export interface QuestionSet {
  version: number;
  createdAt: number;
  /** Why this version exists. */
  reason: string;
  questions: WatchQuestion[];
  /** When this version restores an older one, which one. */
  restoredFrom?: number;
}

// ---------- live inputs ----------
export interface ChatEvent {
  kind: "chat";
  id: string;
  ts: number;
  userId: string;
  handle: string;
  nickname: string;
  text: string;
  avatar?: string;
  isFollower?: boolean;
  /** When replayed: the timestamp the event had in the recording. */
  srcTs?: number;
}
export interface GiftEvent { kind: "gift"; id: string; ts: number; handle: string; nickname?: string; avatar?: string; giftName: string; count: number; diamonds: number; srcTs?: number }
export interface LikeEvent { kind: "like"; ts: number; count: number; total: number; srcTs?: number }
export interface MemberEvent { kind: "member"; ts: number; handle: string; nickname: string; avatar?: string; srcTs?: number }
export interface SocialEvent { kind: "social"; ts: number; handle: string; nickname?: string; avatar?: string; action: "follow" | "share" | "other"; srcTs?: number }
export interface ViewerEvent { kind: "viewers"; ts: number; count: number; srcTs?: number }
/** ts = when the utterance STARTED on the media clock (so it lines up with the video); endTs = when it ended. */
export interface TranscriptEvent { kind: "transcript"; id?: string; ts: number; endTs?: number; text: string; final: boolean; srcTs?: number }
export interface CaptionEvent { kind: "caption"; ts: number; text: string; srcTs?: number }
export interface StreamStatusEvent { kind: "stream"; ts: number; state: "connecting" | "live" | "offline" | "error"; username: string; title?: string; detail?: string; srcTs?: number }

export type LiveEvent =
  | ChatEvent | GiftEvent | LikeEvent | MemberEvent | SocialEvent | ViewerEvent
  | TranscriptEvent | CaptionEvent | StreamStatusEvent;

// ---------- what jev sees each tick ----------
export type SourceState = "available" | "stale" | "missing" | "error";
export interface SourceHealth { state: SourceState; /** ms since the last data from this source; -1 when never seen */ ageMs: number; error?: string }

export interface Snapshot {
  ts: number;
  transcript_last_30s: string;
  scene: string[];
  chat_recent: { handle: string; text: string; secs_ago: number }[];
  activity: {
    chat_velocity: "silent" | "quiet" | "steady" | "busy" | "flood";
    viewers: number;
    viewers_trend: "falling" | "flat" | "rising";
    likes_last_30s: "none" | "few" | "many" | "burst";
    gifts_last_60s: string[];
    new_joins_last_30s: "none" | "few" | "many";
  };
  /** Freshness of each source. Not sent to jev as-is; the projection turns it into "(silence)" vs "(audio unavailable)". */
  sources: Record<Source, SourceHealth>;
}

// ---------- decisions ----------
export interface Decision {
  tick: number;
  ts: number;
  version: number;
  latencyMs: number;
  cost: number;
  answers: Record<string, JevAnswer>;
  /** Question ids whose alert condition is met. */
  fired: string[];
  /** Question ids that were not evaluated this tick (their source group failed, or the rule is paused). */
  skipped?: string[];
  /** True when the state had not changed and the previous answers were reused (no jev call). */
  cached?: boolean;
  /** True when at least one source group failed and only the others are in `answers`. */
  partial?: boolean;
}

export interface MessageDecision {
  messageId: string;
  version: number;
  latencyMs: number;
  answers: Record<string, JevAnswer>;
  fired: string[];
  skipped?: string[];
  partial?: boolean;
}

// ---------- highlights: everything jev flagged, as a durable list ----------
export type HighlightKind = "message" | "transcript" | "scene" | "room";
export type Severity = "info" | "warn";

export interface HighlightFlag {
  questionId: string;
  ruleId: string;
  label: string;
  sources: Source[];
  answer: JevAnswer;
}

export interface Highlight {
  id: string;
  ts: number;
  kind: HighlightKind;
  flags: HighlightFlag[];
  /** What was flagged. Filled according to kind and the flag's sources. */
  message?: ChatEvent;
  transcript?: { from: number; to: number; lines: { ts: number; text: string }[] };
  scene?: { ts: number; text: string };
  chat?: { handle: string; text: string; secs_ago: number }[];
  activity?: Snapshot["activity"];
  pinned: boolean;
  resolved: boolean;
  /** Provenance: which session, which question-set version, which decision produced it. */
  sessionId?: string;
  version?: number;
  decision?: { tick?: number; messageId?: string };
  /** The exact state jev judged (projected for the flagged questions' sources): "why did this fire". */
  evidence?: unknown;
  /** Moderation-like flags are warnings; the rest are prompts. Tagged by the server. */
  severity?: Severity;
  /** How it got resolved: by hand, or by jev noticing the host answered / thanked, or as a duplicate, or by expiry. */
  resolvedBy?: "user" | "answered" | "thanked" | "duplicate" | "expired";
  resolvedAt?: number;
  /** Other flags jev judged to ask the same thing (this one is the primary and carries their authors). */
  duplicates?: { ids: string[]; handles: string[] };
  /** This flag asks the same thing as that primary flag; it is resolved and hidden from the queue. */
  duplicateOf?: string;
  /** A task jev created for the host, or an answer it prepared. */
  assist?: AssistPayload;
}

export type AssistPayload =
  | { kind: "thanks"; handle: string; nickname?: string; avatar?: string; gift: string; count: number; diamonds: number }
  | { kind: "promise"; text: string; dueAt?: number }
  | { kind: "faq"; question: string; answer: string };

/** What jev decided about the app itself: the attention regime, budget degradation, a repair, rule advice, interruptibility. */
export type RetentionTag = "keep" | "ok" | "expendable";
export interface AssistState {
  /** how much attention the room needs right now; the tick and captions follow */ regime: "calm" | "normal" | "hot" | null;
  /** 0 = everything on, 1 = vision paused, 2 = vision and chat judging paused (room rules stay) */ degrade: 0 | 1 | 2; degradeReason?: string;
  /** the 80 % budget warning was raised this session */ budgetAlert: boolean;
  /** can the host be interrupted right now? */ interruptible: "free" | "talking" | "busy" | null;
  /** the latest diagnosis: what jev chose, whether the app applied it */ repair: { action: "none" | "restart_media" | "disable_transcription" | "reconnect" | "alert"; detail: string; at: number; applied: boolean } | null;
  /** per rule id: what to do with it and why */ ruleAdvice: Record<string, { advice: "keep" | "refine" | "pause" | "remove"; reason: string; at: number }>;
  /** what the helpers spent this session (USD) */ spent: number;
  at: number;
}

/** A live poll: the host announces the options, jev reads each chat message as a vote (first vote per viewer counts). */
export interface PollState {
  id: string; question: string; options: string[]; startedAt: number; endedAt: number | null;
  counts: Record<string, number>; voters: number; judged: number;
  recent: { handle: string; nickname: string; avatar?: string; option: string; ts: number }[];
}

// ---------- activity log: every model call with its cost ----------
export type LogActor = "jev" | "glm" | "vision" | "deepgram" | "system";
export interface LogEntry {
  id: string;
  ts: number;
  actor: LogActor;
  /** e.g. "tick", "message", "compile", "refine", "auto-refine", "caption", "connect" */
  kind: string;
  detail: string;
  ok: boolean;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  /** "confirmed" when the provider reported it, "estimated" when computed locally (Deepgram minutes), "unknown" when a timeout may still have billed. */
  costKind?: "confirmed" | "estimated" | "unknown";
  /** For jev: how many questions were asked in this call. */
  questions?: number;
  sessionId?: string;
}

/** Running spend, maintained by the server so every client agrees. */
export interface CostTotals {
  /** Spend since the current session started (0 when idle). */
  session: number;
  /** Spend since the server booted. */
  boot: number;
  byActor: Record<LogActor, number>;
  /** Part of `session` that is an estimate rather than a provider-confirmed number. */
  estimated: number;
  /** Money reserved by calls in flight (an admission envelope, reconciled when the call returns). */
  reserved: number;
}

export interface GlmActivity {
  id: string;
  ts: number;
  kind: "compile" | "refine" | "auto-refine";
  status: "running" | "done" | "error";
  summary: string;
  tokens?: number;
}

// ---------- health ----------
export type DeepgramState = "off" | "connecting" | "open" | "backoff" | "gave-up";
export interface HealthInfo {
  ffmpeg: "off" | "running" | "exited";
  recorder: "off" | "running" | "finalizing";
  deepgram: DeepgramState;
  deepgramDetail?: string;
  /** wall clock of the last window tick that completed (0 = none yet) */
  lastTickAt: number;
  chatBacklog: number;
  chatDropped: number;
  /** OpenRouter circuit breaker: open until `until` for `reason` (401/402), or null when closed. */
  breaker: { until: number; reason: string } | null;
  /** Rate-limit gate: no OpenRouter call before this wall clock (0 = none). */
  rateLimitedUntil: number;
  budget: { spent: number; cap: number; stopped: boolean };
  diskFreeBytes: number | null;
}

// ---------- settings ----------
export interface Settings {
  tiktok: {
    username: string; sessionId: string;
    /** Watch the username from boot and connect as soon as they go live. */ autoConnect: boolean;
    /** After connecting to a live, keep watching: reconnect if the stream drops or the server restarts. */ resume: boolean;
    /** Seconds between two "is @user live?" checks while watching. */ pollSec: number;
  };
  keys: { openrouter: string; deepgram: string };
  models: { jev: string; glm: string; vision: string; deepgram: string; language: string };
  timing: {
    /** jev window tick period. */ tickMs: number;
    /** vision caption period. */ captionEveryMs: number;
    /** minimum gap between two highlights of the same room question. */ highlightGapMs: number;
    /** how much transcript / chat jev sees each tick. */ windowMs: number;
    /** transcript excerpt length attached to a highlight. */ excerptMs: number;
    /** toast auto-dismiss (UI). */ toastMs: number;
    /** even when the state is unchanged, ask jev again after this long. */ maxTickGapMs: number;
  };
  decisions: {
    /** choice/score alerts only fire above this confidence. */ fireConfidenceFloor: number;
    /** below this confidence a gauge is drawn as "unsure". */ unsureBelow: number;
    /** parallel per-message jev calls. */ messageConcurrency: number;
    /** judge chat messages at all. */ judgeMessages: boolean;
  };
  budget: {
    /** hard stop on paid calls for the session (USD). 0 = no cap. */ sessionUsd: number;
    /** at most this many chat messages judged per minute; the rest are dropped with a log line. */ chatPerMinute: number;
    /** a chat message older than this when its turn comes is not judged. */ chatMaxAgeMs: number;
    /** chat backlog capacity; the oldest is dropped beyond it. */ chatQueue: number;
  };
  replay: {
    /** replay without any paid call (no jev, vision, GLM). */ dryRun: boolean;
  };
  autoRefine: { enabled: boolean; emaBelow: number; minSamples: number; cooldownMs: number; intervalMs: number };
  media: {
    transcription: boolean; vision: boolean; hls: boolean; recordVideo: boolean; frameWidth: number; frameEverySec: number; audioKeepAlive: boolean;
    /** how many minutes of HLS the DVR keeps on disk (older segments are deleted). */ dvrMinutes: number;
  };
  glm: { temperature: number; maxTokens: number };
  /** Built-in jev helpers (each one is a few cents per live at most) and the app's own automation. */
  assist: {
    /** cap on what the helpers may spend per session (USD); 0 = no cap */ sessionUsd: number;
    /** close a "reply to" prompt when the host answered it */ autoResolve: boolean;
    /** fold flags asking the same thing into one card */ dedupe: boolean;
    /** a "thank X" prompt on gifts, closed when the host does */ thanks: boolean; thanksMinDiamonds: number;
    /** promises the host makes become run-of-show items */ promises: boolean;
    /** prepared answers: one "question => answer" per line */ faq: boolean; faqText: string;
    /** live polls counted from chat */ poll: boolean;
    /** cadence follows the room (calm / normal / hot) */ regime: boolean;
    /** degrade paid features before the budget cap, with an alert at 80 % */ degrade: boolean;
    /** diagnose health problems and apply the safe fixes */ repair: boolean;
    /** suggest keep / refine / pause / remove for each rule */ ruleHygiene: boolean;
    /** score recordings and delete expendable ones when disk is low */ retention: boolean; diskFloorGb: number;
    /** delay chimes while the host cannot be interrupted */ interruptibility: boolean;
  };
}

/** What the UI receives: secrets masked to their last 4 chars, plus which ones are set. */
export interface PublicSettings extends Omit<Settings, "keys" | "tiktok"> {
  tiktok: Settings["tiktok"];
  keys: { openrouter: string; deepgram: string };
  secrets: { openrouter: boolean; deepgram: boolean; tiktokSession: boolean };
  /** Fields whose change only applies after reconnecting the stream. */
  reconnectFields: string[];
  updatedAt: number;
}

export const MASK = "••••";

/** One recorded video segment, positioned on the session's event timeline. */
export interface VideoSegment { url: string; startTs: number; endTs: number }

/** What the player should show: the live HLS playlist, or recorded segments synced to a replay. */
export type VideoSource =
  | { kind: "hls"; url: string; /** wall clock when the HLS recording started (DVR window start) */ startTs: number }
  | { kind: "file"; segments: VideoSegment[]; /** event timestamp the replay started from */ t0: number; /** wall clock when the replay started */ startedAt: number };

export interface RecordingVideo { file: string; startTs: number; endTs: number | null; sizeBytes: number; durationSec: number }
export interface RecordingInfo {
  id: string; events: string; username: string; title?: string; createdAt: number;
  durationSec?: number; sizeBytes: number; eventCount: number; chatCount: number; transcriptCount: number;
  videos: RecordingVideo[];
  /** jev's verdict at the end of the session (retention helper): keep, ok, or expendable when disk runs low. */
  keep?: RetentionTag; keepReason?: string;
}
export interface RecordingPeek { chat: { ts: number; handle: string; nickname: string; text: string }[]; transcript: { ts: number; text: string }[]; captions: { ts: number; text: string }[]; timeline: { t: number; chat: number; transcript: number }[] }

/** Everything the replay timeline needs: extent, where we are, what happened when. */
export interface ReplayInfo {
  id: string;
  username: string;
  title?: string;
  /** first and last event timestamps of the recording */
  t0: number;
  tEnd: number;
  /** wall clock when playback (re)started, and the event-time offset it started from */
  startedAt: number;
  offsetMs: number;
  /** activity per bucket over the whole recording */
  buckets: { chat: number; transcript: number }[];
  bucketMs: number;
  segments: VideoSegment[];
  dryRun: boolean;
}

/** Live session timeline (DVR window): from the first event to now. */
export interface SessionTimeline { startTs: number; endTs: number; buckets: { chat: number; transcript: number }[]; bucketMs: number; segments: VideoSegment[]; /** wall clock before which the HLS DVR has no video any more */ dvrStartTs: number }

/** The stream watcher: while armed it checks whether @username is live and connects; a manual disconnect disarms it. */
export interface WatchState { armed: boolean; username: string; since: number | null; lastCheck: number | null; nextCheck: number | null; lastResult: "live" | "offline" | "error" | null; detail?: string; checks: number }

/** A keyword / regex pattern tried against a recorded or live session before (or after) it becomes a rule. */
export interface PatternTest { ok: true; source: { kind: "session" | "recording"; id: string; username: string }; scope: "message" | "window"; total: number; matched: number; sample: { ts: number; text: string; handle?: string; nickname?: string; avatar?: string }[] }
export interface SearchHit { ts: number; offsetMs: number; kind: "chat" | "transcript"; text: string; handle?: string; nickname?: string; avatar?: string }
export interface MomentContext { ts: number; transcript: { ts: number; text: string }[]; chat: { ts: number; handle: string; nickname: string; text: string; avatar?: string }[]; captions: { ts: number; text: string }[] }

/** On-demand video recording state of the current session. */
export interface RecordingState {
  active: boolean; file?: string; since?: number; segments: number;
  /** "finalizing" while a stopped segment is being remuxed. */
  finalizing: boolean;
  /** id of the current session's recording (basename of its files) */
  sessionId?: string;
  /** id of the recording currently being replayed, if any */
  replayOf?: string;
}

/** What a finished session looked like, published with the reset so the console is not blank. */
export interface SessionSummary {
  sessionId: string;
  username: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  reason: string;
  highlights: number;
  warnings: number;
  spend: number;
  peakViewers: number;
  chatCount: number;
  transcriptCount: number;
  topFired: { id: string; label: string; count: number }[];
  recording?: string;
}

// ---------- WS protocol ----------
export type ServerMessageBody =
  | { type: "hello"; status: StreamStatusEvent; questions: QuestionSet; history: QuestionSet[]; rules: Rule[]; recent: LiveEvent[]; decisions: Decision[]; messageDecisions: MessageDecision[]; glm: GlmActivity[]; highlights: Highlight[]; log: LogEntry[]; settings: PublicSettings; video: VideoSource | null; recording: RecordingState; replay: ReplayInfo | null; totals: CostTotals; health: HealthInfo; summary: SessionSummary | null; sessionId: string | null; watch: WatchState; poll: PollState | null; assist: AssistState; protocol: number }
  | { type: "event"; event: LiveEvent }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "decision"; decision: Decision }
  | { type: "messageDecision"; decision: MessageDecision }
  | { type: "questions"; set: QuestionSet; history: QuestionSet[]; rules: Rule[] }
  | { type: "glm"; activity: GlmActivity }
  | { type: "log"; entry: LogEntry; totals: CostTotals }
  | { type: "settings"; settings: PublicSettings }
  /** The session ended: every client drops its live data (chat, transcript, decisions, toasts). Highlights stay. */
  | { type: "reset"; reason: string; summary: SessionSummary | null }
  | { type: "highlight"; highlight: Highlight; fresh: boolean }
  | { type: "highlightRemoved"; id: string; /** the item can be restored for this long (ms) */ undoMs?: number }
  | { type: "video"; video: VideoSource | null }
  | { type: "recording"; recording: RecordingState }
  | { type: "replay"; replay: ReplayInfo | null }
  | { type: "health"; health: HealthInfo }
  | { type: "session"; sessionId: string | null }
  | { type: "watch"; watch: WatchState }
  | { type: "poll"; poll: PollState | null }
  | { type: "assist"; assist: AssistState };

/** Every message carries a sequence number; `hello` carries the sequence its snapshot was taken at. */
export type ServerMessage = ServerMessageBody & { seq: number };

export const PROTOCOL_VERSION = 2;

export interface FeedbackRequest {
  questionId: string;
  /** What the human says about the flag. "wrong" and "missed" feed the rewrite; "correct" is only recorded. */
  verdict: "wrong" | "missed" | "correct";
  /** The answer the user disagreed with, plus the state it was judged on. */
  answer: JevAnswer;
  stateExcerpt: unknown;
  /** What jev should have answered. */
  expected?: string;
  note?: string;
  highlightId?: string;
  /** When false, record the feedback but do not ask GLM to rewrite the question. */
  rewrite?: boolean;
}

/** Uniform API error envelope. */
export interface ApiError { ok: false; error: string; code?: string }
