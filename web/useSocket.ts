import { useEffect, useReducer, useRef } from "react";
import type { ChatEvent, Decision, GlmActivity, Highlight, LiveEvent, LogEntry, MessageDecision, PublicSettings, QuestionSet, RecordingInfo, RecordingPeek, RecordingState, Rule, ServerMessage, Snapshot, StreamStatusEvent, VideoSource } from "@shared/protocol";

export interface UiState {
  connected: boolean;
  status: StreamStatusEvent | null;
  video: VideoSource | null;
  questions: QuestionSet | null;
  history: QuestionSet[];
  rules: Rule[];
  chat: ChatEvent[];
  messageDecisions: Record<string, MessageDecision>;
  transcript: { ts: number; text: string }[];
  interim: string;
  captions: { ts: number; text: string }[];
  gifts: LiveEvent[];
  snapshot: Snapshot | null;
  decisions: Decision[];
  glm: GlmActivity[];
  totalCost: number;
  /** Edge-triggered: a question's alert just turned on. */
  alerts: Alert[];
  /** Everything jev flagged, durable, newest last. */
  highlights: Highlight[];
  /** Ids of highlights that arrived since the last time the user looked at the Flagged tab. */
  unseen: string[];
  /** Short-lived notifications for fresh highlights. */
  toasts: Highlight[];
  /** Every model call with its cost. */
  log: LogEntry[];
  settings: PublicSettings | null;
  recording: RecordingState;
}
export interface Alert { id: string; ts: number; questionId: string; kind: "window" | "message"; detail?: string; messageId?: string }

const initial: UiState = { connected: false, status: null, video: null, questions: null, history: [], rules: [], chat: [], messageDecisions: {}, transcript: [], interim: "", captions: [], gifts: [], snapshot: null, decisions: [], glm: [], totalCost: 0, alerts: [], highlights: [], unseen: [], toasts: [], log: [], settings: null, recording: { active: false, segments: 0 } };

type Action = { type: "ws"; msg: ServerMessage } | { type: "connected"; value: boolean } | { type: "seen" } | { type: "dismissToast"; id: string };

const cap = <T,>(xs: T[], n: number) => (xs.length > n ? xs.slice(xs.length - n) : xs);

function applyEvent(s: UiState, e: LiveEvent): UiState {
  switch (e.kind) {
    case "chat": return { ...s, chat: cap([...s.chat, e], 300) };
    case "transcript": return e.final ? { ...s, interim: "", transcript: e.text.trim() ? cap([...s.transcript, { ts: e.ts, text: e.text.trim() }], 200) : s.transcript } : { ...s, interim: e.text };
    case "caption": return { ...s, captions: cap([...s.captions, { ts: e.ts, text: e.text }], 40) };
    case "gift": case "social": case "member": return { ...s, gifts: cap([...s.gifts, e], 50) };
    case "stream": return { ...s, status: e };
    default: return s;
  }
}

function reducer(s: UiState, a: Action): UiState {
  if (a.type === "connected") return { ...s, connected: a.value };
  if (a.type === "seen") return s.unseen.length ? { ...s, unseen: [] } : s;
  if (a.type === "dismissToast") return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
  const m = a.msg;
  switch (m.type) {
    case "hello": {
      let next: UiState = { ...initial, connected: true, status: m.status, video: m.video, questions: m.questions, history: m.history, rules: m.rules, decisions: m.decisions, messageDecisions: Object.fromEntries(m.messageDecisions.map((d) => [d.messageId, d])), glm: m.glm, highlights: m.highlights, log: m.log, settings: m.settings, recording: m.recording, totalCost: m.log.reduce((a, e) => a + (e.cost ?? 0), 0) };
      for (const e of m.recent) next = applyEvent(next, e);
      return next;
    }
    case "event": return applyEvent(s, m.event);
    case "snapshot": return { ...s, snapshot: m.snapshot };
    case "decision": {
      const prev = s.decisions.at(-1);
      const fresh = m.decision.fired.filter((id) => !prev?.fired.includes(id)).map((id): Alert => ({ id: `${m.decision.tick}-${id}`, ts: m.decision.ts, questionId: id, kind: "window" }));
      return { ...s, decisions: cap([...s.decisions, m.decision], 180), alerts: cap([...s.alerts, ...fresh], 80) };
    }
    case "messageDecision": {
      const msg = s.chat.find((c) => c.id === m.decision.messageId);
      const fresh = m.decision.fired.map((id): Alert => ({ id: `${m.decision.messageId}-${id}`, ts: Date.now(), questionId: id, kind: "message", messageId: m.decision.messageId, detail: msg ? `${msg.nickname || msg.handle}: ${msg.text}` : undefined }));
      return { ...s, messageDecisions: { ...s.messageDecisions, [m.decision.messageId]: m.decision }, alerts: cap([...s.alerts, ...fresh], 80) };
    }
    case "questions": return { ...s, questions: m.set, history: m.history, rules: m.rules };
    case "glm": {
      const i = s.glm.findIndex((g) => g.id === m.activity.id);
      return { ...s, glm: i >= 0 ? s.glm.map((g, j) => (j === i ? m.activity : g)) : cap([...s.glm, m.activity], 50) };
    }
    case "video": return { ...s, video: m.video };
    case "highlight": {
      const i = s.highlights.findIndex((h) => h.id === m.highlight.id);
      const highlights = i >= 0 ? s.highlights.map((h, j) => (j === i ? m.highlight : h)) : cap([...s.highlights, m.highlight], 500);
      return m.fresh ? { ...s, highlights, unseen: [...s.unseen, m.highlight.id], toasts: cap([...s.toasts, m.highlight], 4) } : { ...s, highlights };
    }
    case "settings": return { ...s, settings: m.settings };
    case "recording": return { ...s, recording: m.recording };
    case "reset": return { ...s, chat: [], messageDecisions: {}, transcript: [], interim: "", captions: [], gifts: [], snapshot: null, decisions: [], alerts: [], toasts: [], unseen: [], video: null, highlights: s.highlights.filter((h) => h.pinned) };
    case "log": return { ...s, log: cap([...s.log, m.entry], 600), totalCost: s.totalCost + (m.entry.cost ?? 0) };
    case "highlightRemoved": return { ...s, highlights: s.highlights.filter((h) => h.id !== m.id), toasts: s.toasts.filter((h) => h.id !== m.id) };
  }
}

export function useSocket() {
  const [state, dispatch] = useReducer(reducer, initial);
  const markSeen = () => dispatch({ type: "seen" });
  const dismissToast = (id: string) => dispatch({ type: "dismissToast", id });
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => dispatch({ type: "connected", value: true });
      ws.onmessage = (ev) => dispatch({ type: "ws", msg: JSON.parse(ev.data) as ServerMessage });
      ws.onclose = () => { dispatch({ type: "connected", value: false }); if (!closed) timer = setTimeout(open, 1500); };
    };
    open();
    return () => { closed = true; clearTimeout(timer); wsRef.current?.close(); };
  }, []);
  return { ...state, markSeen, dismissToast };
}

export const api = {
  connect: (username: string, replay?: string) => fetch("/api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, replay }) }).then((r) => r.json()),
  disconnect: () => fetch("/api/disconnect", { method: "POST" }).then((r) => r.json()),
  addRule: (text: string, sources: string[]) => fetch("/api/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sources }) }).then((r) => r.json()),
  removeRule: (id: string) => fetch(`/api/rules/${id}`, { method: "DELETE" }).then((r) => r.json()),
  feedback: (body: unknown) => fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
  recordings: () => fetch("/api/recordings").then((r) => r.json() as Promise<RecordingInfo[]>),
  patchHighlight: (id: string, patch: { pinned?: boolean; resolved?: boolean }) => fetch(`/api/highlights/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) => r.json()),
  removeHighlight: (id: string) => fetch(`/api/highlights/${id}`, { method: "DELETE" }).then((r) => r.json()),
  startRecording: () => fetch("/api/record/start", { method: "POST" }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>),
  stopRecording: () => fetch("/api/record/stop", { method: "POST" }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>),
  peekRecording: (id: string) => fetch(`/api/recordings/${id}/peek`).then((r) => r.json() as Promise<RecordingPeek>),
  deleteRecording: (id: string) => fetch(`/api/recordings/${id}`, { method: "DELETE" }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>),
  getSettings: () => fetch("/api/settings").then((r) => r.json() as Promise<PublicSettings>),
  saveSettings: (patch: Record<string, unknown>) => fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) => r.json() as Promise<{ ok: boolean; settings: PublicSettings; error?: string }>),
  resetSettings: () => fetch("/api/settings/reset", { method: "POST" }).then((r) => r.json() as Promise<{ ok: boolean; settings: PublicSettings }>),
  testSetting: (which: "openrouter" | "deepgram" | "models", value?: string) => fetch("/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ which, value }) }).then((r) => r.json() as Promise<{ ok: boolean; ms?: number; detail?: string; models?: { glm: string[]; vision: string[]; jev: string[] } }>),
  clearHighlights: (mode: "resolved" | "all") => fetch("/api/highlights/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }).then((r) => r.json()),
};
