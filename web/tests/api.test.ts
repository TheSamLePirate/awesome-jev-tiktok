import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError, api, onApiError, request } from "../lib/api";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Call[] = [];
let reply: (c: Call) => Response | Promise<Response> = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  (globalThis as any).fetch = mock(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined };
    calls.push(c);
    if (init.signal) { const s = init.signal as AbortSignal; if (s.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); }
    return reply(c);
  });
});
afterEach(() => { (globalThis as any).fetch = realFetch; });

describe("request", () => {
  test("GET without body, POST with JSON body, the session cookie and never a token header", async () => {
    localStorage.setItem("jev.token", "abc");
    await request("/api/x");
    expect(calls[0]).toMatchObject({ method: "GET" }); expect(calls[0].headers["Content-Type"]).toBeUndefined(); expect(calls[0].headers.Authorization).toBeUndefined();
    expect((globalThis.fetch as any).mock.calls[0][1].credentials).toBe("same-origin");
    await request("/api/y", { body: { a: 1 } });
    expect(calls[1]).toMatchObject({ method: "POST", body: '{"a":1}', headers: { "Content-Type": "application/json" } });
    localStorage.clear();
    await request("/api/z", { method: "DELETE" });
    expect(calls[2].headers.Authorization).toBeUndefined();
    reply = () => new Response("", { status: 204 });
    expect(await request("/api/empty")).toBeNull();
  });
  test("error envelope, HTTP error, invalid JSON, listeners and silent", async () => {
    const seen: ApiError[] = [];
    const off = onApiError((e) => seen.push(e));
    reply = () => new Response(JSON.stringify({ ok: false, error: "nope", code: "E1" }), { status: 200 });
    await expect(request("/api/a")).rejects.toMatchObject({ message: "nope", status: 200, code: "E1" });
    reply = () => new Response("<html>boom", { status: 500 });
    await expect(request("/api/b")).rejects.toMatchObject({ message: "HTTP 500", status: 500 });
    await expect(request("/api/c", { silent: true })).rejects.toBeInstanceOf(ApiError);
    expect(seen.length).toBe(2);
    reply = () => { throw new Error("offline"); };
    await expect(request("/api/d")).rejects.toMatchObject({ message: "network error: offline", status: 0 });
    reply = () => { throw new Error("offline"); };
    await expect(request("/api/e", { silent: true })).rejects.toMatchObject({ status: 0 });
    expect(seen.length).toBe(3);
    off();
    reply = () => { throw new Error("offline"); };
    await expect(request("/api/f")).rejects.toBeInstanceOf(ApiError);
    expect(seen.length).toBe(3);
  });
  test("timeout aborts", async () => {
    reply = (c) => new Promise((_, rej) => { const s = (globalThis.fetch as any).mock.calls.at(-1)[1].signal as AbortSignal; s.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); void c; });
    await expect(request("/api/slow", { timeoutMs: 5, silent: true })).rejects.toMatchObject({ message: "request timed out" });
  });
});

describe("api methods hit the right routes", () => {
  test("every endpoint", async () => {
    reply = () => new Response(JSON.stringify({ ok: true, sessionId: "s", undoMs: 1, removed: [], settings: {} }), { status: 200 });
    await api.auth(); await api.login("tok"); await api.logout();
    await api.connect("user"); await api.connect("replay", "rec-1", { simulate: true, offsetMs: 5 });
    await api.disconnect(); await api.watch(true, "x"); await api.addRule({ text: "t", sources: ["chat"] }); await api.removeRule("r1"); await api.restoreRule("r1"); await api.pauseRule("r1", true); await api.editRule("r1", { text: "t2" }); await api.testPattern({ pattern: "x" });
    await api.restoreVersion(3); await api.feedback({ questionId: "q" }); await api.recordings(); await api.patchHighlight("h1", { pinned: true }); await api.removeHighlight("h1"); await api.restoreHighlight("h1");
    await api.clearHighlights("resolved"); await api.search("héllo", ["chat"]); await api.context(123); await api.context(1, 5); await api.timeline(); await api.seekReplay(10); await api.startRecording(); await api.stopRecording();
    await api.peekRecording("rec/1"); await api.deleteRecording("rec-1"); await api.getSettings(); await api.saveSettings({ a: 1 }); await api.resetSettings(); await api.testSetting("openrouter", "k"); await api.health();
    const routes = calls.map((c) => `${c.method} ${c.url}`);
    expect(routes).toEqual([
      "GET /api/auth", "POST /api/auth/login", "POST /api/auth/logout",
      "POST /api/connect", "POST /api/connect", "POST /api/disconnect", "POST /api/watch", "POST /api/rules", "DELETE /api/rules/r1", "POST /api/rules/r1/restore", "PATCH /api/rules/r1", "PATCH /api/rules/r1", "POST /api/rules/test",
      "POST /api/versions/3/restore", "POST /api/feedback", "GET /api/recordings", "PATCH /api/highlights/h1", "DELETE /api/highlights/h1", "POST /api/highlights/h1/restore",
      "POST /api/highlights/clear", "GET /api/search?q=h%C3%A9llo&kinds=chat", "GET /api/context?ts=123&span=30000", "GET /api/context?ts=1&span=5", "GET /api/timeline", "POST /api/replay/seek", "POST /api/record/start", "POST /api/record/stop",
      "GET /api/recordings/rec%2F1/peek", "DELETE /api/recordings/rec-1", "GET /api/settings", "PUT /api/settings", "POST /api/settings/reset", "POST /api/settings/test", "GET /api/health",
    ]);
    expect(JSON.parse(calls[4].body!)).toEqual({ username: "replay", replay: "rec-1", simulate: true, offsetMs: 5 }); expect(JSON.parse(calls[1].body!)).toEqual({ token: "tok" });
    expect(JSON.parse(calls[10].body!)).toEqual({ paused: true }); expect(JSON.parse(calls[6].body!)).toEqual({ armed: true, username: "x" });
  });
});
