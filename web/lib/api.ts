import type { MomentContext, PatternTest, PollState, WatchState, PublicSettings, RecordingInfo, RecordingPeek, Rule, SearchHit, SessionTimeline, WatchQuestion } from "@shared/protocol";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

type Listener = (e: ApiError) => void;
const listeners = new Set<Listener>();
/** The app registers one listener that turns API failures into toasts. */
export const onApiError = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * fetch with: JSON body, the session cookie (same origin), a timeout that aborts, HTTP status checked, `{ok:false}`
 * envelopes rejected, and every failure reported once to the error listeners (so a 500 from any route shows a toast
 * and buttons recover).
 */
export async function request<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number; silent?: boolean } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 20_000);
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, signal: ctl.signal, credentials: "same-origin" });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok || (data && typeof data === "object" && data.ok === false)) {
      const err = new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data?.code);
      if (!init.silent) listeners.forEach((l) => l(err));
      throw err;
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const err = new ApiError(ctl.signal.aborted ? "request timed out" : `network error: ${(e as Error).message}`, 0);
    if (!init.silent) listeners.forEach((l) => l(err));
    throw err;
  } finally { clearTimeout(timer); }
}

type Ok<T = {}> = { ok: true } & T;

export const api = {
  /** Does this server need a token, and does this browser hold a session? Never toasts: it runs before the app. */
  auth: () => request<{ ok: true; required: boolean; authenticated: boolean }>("/api/auth", { silent: true, timeoutMs: 8000 }),
  login: (token: string) => request<{ ok: true; required: boolean }>("/api/auth/login", { body: { token }, silent: true }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  connect: (username: string, replay?: string, opts: { offsetMs?: number; simulate?: boolean } = {}) => request<Ok<{ sessionId: string }>>("/api/connect", { body: { username, replay, ...opts }, timeoutMs: 95_000 }),
  disconnect: () => request<Ok>("/api/disconnect", { method: "POST" }),
  startPoll: (question: string, options: string[]) => request<Ok<{ poll: PollState }>>("/api/poll", { body: { question, options } }),
  endPoll: () => request<Ok<{ poll: PollState | null }>>("/api/poll/end", { method: "POST" }),
  clearPoll: () => request<Ok>("/api/poll", { method: "DELETE" }),
  watch: (armed: boolean, username?: string) => request<Ok<{ watch: WatchState }>>("/api/watch", { body: { armed, username } }),
  addRule: (body: { text: string; sources: string[]; kind?: "jev" | "keyword"; pattern?: string; flags?: string; label?: string; scope?: "window" | "message" }) => request<Ok<{ rule: unknown }>>("/api/rules", { body, timeoutMs: 90_000 }),
  removeRule: (id: string) => request<Ok<{ undoMs: number }>>(`/api/rules/${id}`, { method: "DELETE" }),
  restoreRule: (id: string) => request<Ok>(`/api/rules/${id}/restore`, { method: "POST" }),
  pauseRule: (id: string, paused: boolean) => request<Ok>(`/api/rules/${id}`, { method: "PATCH", body: { paused } }),
  editRule: (id: string, body: { text?: string; sources?: string[]; pattern?: string; flags?: string; label?: string }) => request<Ok<{ rule: Rule; questions: WatchQuestion[]; recompiled: boolean }>>(`/api/rules/${id}`, { method: "PATCH", body, timeoutMs: 90_000 }),
  testPattern: (body: { pattern: string; flags?: string; scope?: "window" | "message"; recording?: string }) => request<PatternTest>("/api/rules/test", { body, silent: true }),
  restoreVersion: (v: number) => request<Ok>(`/api/versions/${v}/restore`, { method: "POST" }),
  feedback: (body: unknown) => request<Ok<{ rewritten: boolean }>>("/api/feedback", { body, timeoutMs: 90_000 }),
  recordings: () => request<RecordingInfo[]>("/api/recordings", { silent: true }),
  patchHighlight: (id: string, patch: { pinned?: boolean; resolved?: boolean }) => request<Ok>(`/api/highlights/${id}`, { method: "PATCH", body: patch }),
  removeHighlight: (id: string) => request<Ok<{ undoMs: number }>>(`/api/highlights/${id}`, { method: "DELETE" }),
  restoreHighlight: (id: string) => request<Ok>(`/api/highlights/${id}/restore`, { method: "POST" }),
  clearHighlights: (mode: "resolved" | "all") => request<Ok<{ removed: string[]; undoMs: number }>>("/api/highlights/clear", { body: { mode } }),
  search: (q: string, kinds: string[]) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}&kinds=${kinds.join(",")}`, { silent: true }),
  context: (ts: number, span = 30_000) => request<MomentContext>(`/api/context?ts=${ts}&span=${span}`, { silent: true }),
  timeline: () => request<SessionTimeline | null>("/api/timeline", { silent: true }),
  seekReplay: (offsetMs: number) => request<Ok<{ offsetMs: number }>>("/api/replay/seek", { body: { offsetMs } }),
  startRecording: () => request<Ok<{ file: string }>>("/api/record/start", { method: "POST" }),
  stopRecording: () => request<Ok<{ file: string }>>("/api/record/stop", { method: "POST" }),
  peekRecording: (id: string) => request<RecordingPeek>(`/api/recordings/${encodeURIComponent(id)}/peek`, { silent: true }),
  deleteRecording: (id: string) => request<Ok>(`/api/recordings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getSettings: () => request<PublicSettings>("/api/settings"),
  saveSettings: (patch: Record<string, unknown>) => request<Ok<{ settings: PublicSettings }>>("/api/settings", { method: "PUT", body: patch }),
  resetSettings: () => request<Ok<{ settings: PublicSettings }>>("/api/settings/reset", { method: "POST" }),
  testSetting: (which: "openrouter" | "deepgram" | "models", value?: string) => request<{ ok: boolean; ms?: number; detail?: string; models?: { glm: string[]; vision: string[]; jev: string[] } }>("/api/settings/test", { body: { which, value }, timeoutMs: 30_000, silent: true }),
  health: () => request<{ ok: true }>("/api/health", { silent: true }),
};
