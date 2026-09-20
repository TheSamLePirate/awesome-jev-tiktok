import { useEffect, useReducer, useRef } from "react";
import type { ChatEvent, Decision, GlmActivity, LiveEvent, MessageDecision, QuestionSet, Rule, ServerMessage, Snapshot, StreamStatusEvent } from "@shared/protocol";

export interface UiState {
  connected: boolean;
  status: StreamStatusEvent | null;
  hlsUrl: string | null;
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
}
export interface Alert { id: string; ts: number; questionId: string; kind: "window" | "message"; detail?: string; messageId?: string }

const initial: UiState = { connected: false, status: null, hlsUrl: null, questions: null, history: [], rules: [], chat: [], messageDecisions: {}, transcript: [], interim: "", captions: [], gifts: [], snapshot: null, decisions: [], glm: [], totalCost: 0, alerts: [] };

type Action = { type: "ws"; msg: ServerMessage } | { type: "connected"; value: boolean };

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
  const m = a.msg;
  switch (m.type) {
    case "hello": {
      let next: UiState = { ...initial, connected: true, status: m.status, hlsUrl: m.hlsUrl, questions: m.questions, history: m.history, rules: m.rules, decisions: m.decisions, messageDecisions: Object.fromEntries(m.messageDecisions.map((d) => [d.messageId, d])), glm: m.glm, totalCost: m.decisions.reduce((a, d) => a + d.cost, 0) };
      for (const e of m.recent) next = applyEvent(next, e);
      return next;
    }
    case "event": return applyEvent(s, m.event);
    case "snapshot": return { ...s, snapshot: m.snapshot };
    case "decision": {
      const prev = s.decisions.at(-1);
      const fresh = m.decision.fired.filter((id) => !prev?.fired.includes(id)).map((id): Alert => ({ id: `${m.decision.tick}-${id}`, ts: m.decision.ts, questionId: id, kind: "window" }));
      return { ...s, decisions: cap([...s.decisions, m.decision], 180), totalCost: s.totalCost + m.decision.cost, alerts: cap([...s.alerts, ...fresh], 80) };
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
    case "hls": return { ...s, hlsUrl: m.url };
  }
}

export function useSocket() {
  const [state, dispatch] = useReducer(reducer, initial);
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
  return state;
}

export const api = {
  connect: (username: string, replay?: string) => fetch("/api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, replay }) }).then((r) => r.json()),
  disconnect: () => fetch("/api/disconnect", { method: "POST" }).then((r) => r.json()),
  addRule: (text: string, sources: string[]) => fetch("/api/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sources }) }).then((r) => r.json()),
  removeRule: (id: string) => fetch(`/api/rules/${id}`, { method: "DELETE" }).then((r) => r.json()),
  feedback: (body: unknown) => fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
  recordings: () => fetch("/api/recordings").then((r) => r.json() as Promise<string[]>),
};
