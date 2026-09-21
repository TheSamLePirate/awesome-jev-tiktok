import { useSyncExternalStore, useRef } from "react";
import { PROTOCOL_VERSION, type ChatEvent, type CostTotals, type Decision, type GlmActivity, type HealthInfo, type Highlight, type LiveEvent, type LogEntry, type MessageDecision, type PublicSettings, type QuestionSet, type RecordingState, type ReplayInfo, type Rule, type ServerMessage, type SessionSummary, type Severity, type Snapshot, type PollState, type StreamStatusEvent, type VideoSource, type WatchQuestion, type WatchState } from "@shared/protocol";

export type SocialEvent = Extract<LiveEvent, { kind: "gift" | "social" | "member" }>;
export interface TranscriptLine { id: string; ts: number; text: string }
export interface Toast {
  id: string; ts: number; kind: "highlight" | "info" | "error" | "undo";
  title: string; body?: string; severity?: Severity;
  highlight?: Highlight;
  action?: { label: string; run: () => void };
  /** Override the default lifetime (ms). */
  durationMs?: number;
}

export interface UiState {
  connected: boolean;
  /** Server speaks a different protocol version: reload needed. */
  protocolMismatch: boolean;
  status: StreamStatusEvent | null;
  video: VideoSource | null;
  questions: QuestionSet | null;
  history: QuestionSet[];
  rules: Rule[];
  /** Derived once per `questions` change so panels receive stable arrays. */
  windowQs: WatchQuestion[];
  messageQs: WatchQuestion[];
  chat: ChatEvent[];
  messageDecisions: Record<string, MessageDecision>;
  transcript: TranscriptLine[];
  interim: string;
  captions: { ts: number; text: string }[];
  social: SocialEvent[];
  viewers: { ts: number; count: number }[];
  snapshot: Snapshot | null;
  decisions: Decision[];
  glm: GlmActivity[];
  totals: CostTotals;
  highlights: Highlight[];
  /** Ids of highlights that arrived since the last time the user looked at the Flagged tab. */
  unseen: string[];
  toasts: Toast[];
  log: LogEntry[];
  settings: PublicSettings | null;
  recording: RecordingState;
  replay: ReplayInfo | null;
  health: HealthInfo | null;
  summary: SessionSummary | null;
  sessionId: string | null;
  /** The stream watcher (auto-connect / resume), null until hello. */
  watch: WatchState | null;
  /** The live poll, if any. */
  poll: PollState | null;
  /** The server wants a token: true after a 401 (the session expired or the token changed); the console shows the sign-in. */
  authRequired: boolean;
  /** Whether this server is token-protected at all (from /api/auth at boot); drives the "sign out" control. */
  authProtected: boolean;
}

const zeroTotals = (): CostTotals => ({ session: 0, boot: 0, byActor: { jev: 0, glm: 0, vision: 0, deepgram: 0, system: 0 }, estimated: 0, reserved: 0 });
const initial: UiState = { connected: false, protocolMismatch: false, status: null, video: null, questions: null, history: [], rules: [], windowQs: [], messageQs: [], chat: [], messageDecisions: {}, transcript: [], interim: "", captions: [], social: [], viewers: [], snapshot: null, decisions: [], glm: [], totals: zeroTotals(), highlights: [], unseen: [], toasts: [], log: [], settings: null, recording: { active: false, segments: 0, finalizing: false }, replay: null, health: null, summary: null, sessionId: null, watch: null, poll: null, authRequired: false, authProtected: false };

export type Action =
  | { type: "ws"; msg: ServerMessage }
  | { type: "connected"; value: boolean }
  | { type: "seen" }
  | { type: "dismissToast"; id: string }
  | { type: "toast"; toast: Omit<Toast, "id" | "ts"> & { id?: string } }
  | { type: "clearToasts" }
  | { type: "auth"; required?: boolean; protected?: boolean };

const CHAT_CAP = 300;
const cap = <T,>(xs: T[], n: number) => (xs.length > n ? xs.slice(xs.length - n) : xs);
let transcriptSeq = 0;
const nextId = () => `t-${++transcriptSeq}`;

const deriveQs = (set: QuestionSet | null) => ({ windowQs: set?.questions.filter((q) => q.scope === "window") ?? [], messageQs: set?.questions.filter((q) => q.scope === "message") ?? [] });

/** Chat is capped; message decisions follow the chat so the map never grows past what is displayed. */
const pushChat = (s: UiState, e: ChatEvent): UiState => {
  const chat = cap([...s.chat, e], CHAT_CAP);
  if (chat.length < s.chat.length + 1) {
    const keep = new Set(chat.map((c) => c.id));
    const md: Record<string, MessageDecision> = {};
    for (const k in s.messageDecisions) if (keep.has(k)) md[k] = s.messageDecisions[k];
    return { ...s, chat, messageDecisions: md };
  }
  return { ...s, chat };
};

function applyEvent(s: UiState, e: LiveEvent): UiState {
  switch (e.kind) {
    case "chat": return pushChat(s, e);
    case "transcript": return e.final ? { ...s, interim: "", transcript: e.text.trim() ? cap([...s.transcript, { id: e.id ?? nextId(), ts: e.ts, text: e.text.trim() }], 200) : s.transcript } : { ...s, interim: e.text };
    case "caption": return { ...s, captions: cap([...s.captions, { ts: e.ts, text: e.text }], 40) };
    case "gift": case "social": case "member": return { ...s, social: cap([...s.social, e], 80) };
    case "viewers": return { ...s, viewers: cap([...s.viewers, { ts: e.ts, count: e.count }], 120) };
    case "stream": return { ...s, status: e };
    default: return s;
  }
}

const toastId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case "connected": return s.connected === a.value ? s : { ...s, connected: a.value };
    case "seen": return s.unseen.length ? { ...s, unseen: [] } : s;
    case "dismissToast": return s.toasts.some((t) => t.id === a.id) ? { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) } : s;
    case "clearToasts": return s.toasts.length ? { ...s, toasts: [] } : s;
    case "auth": { const required = a.required ?? s.authRequired, prot = a.protected ?? s.authProtected; return required === s.authRequired && prot === s.authProtected ? s : { ...s, authRequired: required, authProtected: prot }; }
    case "toast": return { ...s, toasts: cap([...s.toasts.filter((t) => t.id !== a.toast.id), { ...a.toast, id: a.toast.id ?? toastId(), ts: Date.now() }], 5) };
    case "ws": return applyMessage(s, a.msg);
  }
}

function applyMessage(s: UiState, m: ServerMessage): UiState {
  switch (m.type) {
    case "hello": {
      const md: Record<string, MessageDecision> = {};
      for (const d of m.messageDecisions) md[d.messageId] = d;
      let next: UiState = { ...initial, connected: true, protocolMismatch: m.protocol !== PROTOCOL_VERSION, status: m.status, video: m.video, questions: m.questions, ...deriveQs(m.questions), history: m.history, rules: m.rules, decisions: m.decisions, messageDecisions: md, glm: m.glm, highlights: m.highlights, log: m.log, settings: m.settings, recording: m.recording, replay: m.replay, totals: m.totals, health: m.health, summary: m.summary, sessionId: m.sessionId, watch: m.watch, poll: m.poll, authProtected: s.authProtected, authRequired: false, toasts: s.toasts.filter((t) => t.kind !== "highlight") };
      for (const e of m.recent) next = applyEvent(next, e);
      return next;
    }
    case "event": return applyEvent(s, m.event);
    case "snapshot": return { ...s, snapshot: m.snapshot };
    case "decision": return { ...s, decisions: cap([...s.decisions, m.decision], 180) };
    case "messageDecision": return s.chat.some((c) => c.id === m.decision.messageId) ? { ...s, messageDecisions: { ...s.messageDecisions, [m.decision.messageId]: m.decision } } : s;
    case "questions": return { ...s, questions: m.set, ...deriveQs(m.set), history: m.history, rules: m.rules };
    case "glm": {
      const i = s.glm.findIndex((g) => g.id === m.activity.id);
      return { ...s, glm: i >= 0 ? s.glm.map((g, j) => (j === i ? m.activity : g)) : cap([...s.glm, m.activity], 50) };
    }
    case "video": return { ...s, video: m.video };
    case "highlight": {
      const i = s.highlights.findIndex((h) => h.id === m.highlight.id);
      const highlights = i >= 0 ? s.highlights.map((h, j) => (j === i ? m.highlight : h)) : [...s.highlights, m.highlight].sort((a, b) => a.ts - b.ts);
      if (!m.fresh) return { ...s, highlights };
      const title = m.highlight.flags.map((f) => f.label).join(" · ");
      return { ...s, highlights, unseen: [...s.unseen, m.highlight.id], toasts: cap([...s.toasts, { id: `hl-${m.highlight.id}`, ts: Date.now(), kind: "highlight", title, severity: m.highlight.severity, highlight: m.highlight }], 5) };
    }
    case "settings": return { ...s, settings: m.settings };
    case "recording": return { ...s, recording: m.recording };
    case "replay": return { ...s, replay: m.replay };
    case "health": return { ...s, health: m.health };
    case "session": return { ...s, sessionId: m.sessionId };
    case "watch": return { ...s, watch: m.watch };
    case "poll": return { ...s, poll: m.poll };
    // Session data goes; highlights, rules, versions, settings, log and the summary stay.
    case "reset": return { ...s, chat: [], messageDecisions: {}, transcript: [], interim: "", captions: [], social: [], viewers: [], snapshot: null, decisions: [], unseen: m.reason === "seek" ? s.unseen : [], toasts: s.toasts.filter((t) => t.kind !== "highlight"), video: m.reason === "seek" ? s.video : null, summary: m.summary ?? s.summary, poll: m.reason === "seek" ? s.poll : null };
    case "log": return { ...s, log: cap([...s.log, m.entry], 600), totals: m.totals };
    case "highlightRemoved": return { ...s, highlights: s.highlights.filter((h) => h.id !== m.id), toasts: s.toasts.filter((t) => t.highlight?.id !== m.id) };
    default: return s;
  }
}

// ---------------- external store: slices subscribe to what they read, nothing else re-renders ----------------
type Listener = () => void;
const listeners = new Set<Listener>();
let state: UiState = initial;
export const getState = () => state;
export const dispatch = (a: Action) => { const next = reducer(state, a); if (next !== state) { state = next; listeners.forEach((l) => l()); } };
const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Read a slice of the state. The selected value is compared with the previous one (shallow by default), so a selector
 * that builds a new array or object each time still yields a stable identity while its content is unchanged. The
 * component re-renders only when the selected value really changes.
 */
export function useStore<T>(selector: (s: UiState) => T, eq: (a: T, b: T) => boolean = shallowEq): T {
  const last = useRef<{ v: T } | null>(null);
  // A fresh getSnapshot per render is fine for useSyncExternalStore; what must be stable is the returned value.
  const get = () => {
    const v = selector(state);
    if (last.current && eq(last.current.v, v)) return last.current.v;
    last.current = { v };
    return v;
  };
  return useSyncExternalStore(subscribe, get, get);
}

export const shallowEq = <T,>(a: T, b: T): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a) as (keyof T)[], kb = Object.keys(b) as (keyof T)[];
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]));
};

export const toast = (t: Omit<Toast, "id" | "ts"> & { id?: string }) => dispatch({ type: "toast", toast: t });
export const dismissToast = (id: string) => dispatch({ type: "dismissToast", id });
export const markSeen = () => dispatch({ type: "seen" });

// ---------------- websocket ----------------
let socketStarted = false;
/** Open the WebSocket once per page; reconnects with backoff; `hello` resets state and later messages are applied in order. */
export function startSocket(token: string) {
  if (socketStarted) return;
  socketStarted = true;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    let helloSeq: number | null = null;
    let lastSeq = 0;
    const pending: ServerMessage[] = [];
    ws.onopen = () => { attempt = 0; dispatch({ type: "connected", value: true }); };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data) as ServerMessage; } catch { return; }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      if (msg.type === "hello") {
        helloSeq = msg.seq; lastSeq = msg.seq;
        dispatch({ type: "ws", msg });
        // Messages that raced the hello: apply only those newer than the snapshot, in order.
        for (const p of pending.sort((a, b) => a.seq - b.seq)) if (p.seq > lastSeq) { lastSeq = p.seq; dispatch({ type: "ws", msg: p }); }
        pending.length = 0;
        return;
      }
      if (helloSeq === null) { pending.push(msg); return; }
      if (typeof msg.seq === "number") { if (msg.seq <= lastSeq) return; lastSeq = msg.seq; }
      dispatch({ type: "ws", msg });
    };
    ws.onclose = () => {
      dispatch({ type: "connected", value: false });
      attempt++;
      // A socket that never opens may be a 401 (session expired): ask, and show the sign-in instead of retrying forever.
      if (attempt >= 2 && helloSeq === null) void fetch("/api/auth", { credentials: "same-origin" }).then((r) => r.json()).then((a: { required?: boolean; authenticated?: boolean }) => { if (a.required && !a.authenticated) dispatch({ type: "auth", required: true, protected: true }); }).catch(() => {});
      if (getState().authRequired) return;
      timer = setTimeout(open, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  open();
  return () => clearTimeout(timer);
}
