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
}

export interface Rule {
  id: string;
  text: string;
  sources: Source[];
  createdAt: number;
}

export interface QuestionSet {
  version: number;
  createdAt: number;
  /** Why this version exists. */
  reason: string;
  questions: WatchQuestion[];
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
}
export interface GiftEvent { kind: "gift"; id: string; ts: number; handle: string; giftName: string; count: number; diamonds: number }
export interface LikeEvent { kind: "like"; ts: number; count: number; total: number }
export interface MemberEvent { kind: "member"; ts: number; handle: string; nickname: string }
export interface SocialEvent { kind: "social"; ts: number; handle: string; action: "follow" | "share" | "other" }
export interface ViewerEvent { kind: "viewers"; ts: number; count: number }
export interface TranscriptEvent { kind: "transcript"; ts: number; text: string; final: boolean }
export interface CaptionEvent { kind: "caption"; ts: number; text: string }
export interface StreamStatusEvent { kind: "stream"; ts: number; state: "connecting" | "live" | "offline" | "error"; username: string; title?: string; detail?: string }

export type LiveEvent =
  | ChatEvent | GiftEvent | LikeEvent | MemberEvent | SocialEvent | ViewerEvent
  | TranscriptEvent | CaptionEvent | StreamStatusEvent;

// ---------- what jev sees each tick ----------
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
}

export interface MessageDecision {
  messageId: string;
  version: number;
  latencyMs: number;
  answers: Record<string, JevAnswer>;
  fired: string[];
}

// ---------- highlights: everything jev flagged, as a durable list ----------
export type HighlightKind = "message" | "transcript" | "scene" | "room";

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
}

// ---------- activity log: every model call with its cost ----------
export type LogActor = "jev" | "glm" | "vision" | "system";
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
  /** For jev: how many questions were asked in this call. */
  questions?: number;
}

export interface GlmActivity {
  id: string;
  ts: number;
  kind: "compile" | "refine" | "auto-refine";
  status: "running" | "done" | "error";
  summary: string;
  tokens?: number;
}

// ---------- settings ----------
export interface Settings {
  tiktok: { username: string; sessionId: string };
  keys: { openrouter: string; deepgram: string };
  models: { jev: string; glm: string; vision: string; deepgram: string; language: string };
  timing: {
    /** jev window tick period. */ tickMs: number;
    /** vision caption period. */ captionEveryMs: number;
    /** minimum gap between two highlights of the same room question. */ highlightGapMs: number;
    /** how much transcript / chat jev sees each tick. */ windowMs: number;
    /** transcript excerpt length attached to a highlight. */ excerptMs: number;
    /** toast auto-dismiss (UI). */ toastMs: number;
  };
  decisions: {
    /** choice/score alerts only fire above this confidence. */ fireConfidenceFloor: number;
    /** below this confidence a gauge is drawn as "unsure". */ unsureBelow: number;
    /** parallel per-message jev calls. */ messageConcurrency: number;
    /** judge chat messages at all. */ judgeMessages: boolean;
  };
  autoRefine: { enabled: boolean; emaBelow: number; minSamples: number; cooldownMs: number; intervalMs: number };
  media: { transcription: boolean; vision: boolean; hls: boolean; frameWidth: number; frameEverySec: number; audioKeepAlive: boolean };
  glm: { temperature: number; maxTokens: number };
}

/** What the UI receives: secrets masked to their last 4 chars, plus which ones are set. */
export interface PublicSettings extends Omit<Settings, "keys" | "tiktok"> {
  tiktok: { username: string; sessionId: string };
  keys: { openrouter: string; deepgram: string };
  secrets: { openrouter: boolean; deepgram: boolean; tiktokSession: boolean };
  /** Fields whose change only applies after reconnecting the stream. */
  reconnectFields: string[];
  updatedAt: number;
}

export const MASK = "••••";

// ---------- WS protocol ----------
export type ServerMessage =
  | { type: "hello"; status: StreamStatusEvent; questions: QuestionSet; history: QuestionSet[]; rules: Rule[]; recent: LiveEvent[]; decisions: Decision[]; messageDecisions: MessageDecision[]; glm: GlmActivity[]; highlights: Highlight[]; log: LogEntry[]; settings: PublicSettings; hlsUrl: string | null }
  | { type: "event"; event: LiveEvent }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "decision"; decision: Decision }
  | { type: "messageDecision"; decision: MessageDecision }
  | { type: "questions"; set: QuestionSet; history: QuestionSet[]; rules: Rule[] }
  | { type: "glm"; activity: GlmActivity }
  | { type: "log"; entry: LogEntry }
  | { type: "settings"; settings: PublicSettings }
  | { type: "highlight"; highlight: Highlight; fresh: boolean }
  | { type: "highlightRemoved"; id: string }
  | { type: "hls"; url: string | null };

export interface FeedbackRequest {
  questionId: string;
  /** The answer the user disagreed with, plus the state it was judged on. */
  answer: JevAnswer;
  stateExcerpt: unknown;
  note?: string;
}
