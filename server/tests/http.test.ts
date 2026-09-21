import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The HTTP layer over the real services (jev stubbed), on a random port, with an isolated runtime directory.
const dir = mkdtempSync(path.join(tmpdir(), "jev-http-"));
process.env.JEV_RUNTIME_DIR = dir;
process.env.JEV_RECORDINGS_DIR = path.join(dir, "recordings");
process.env.OPENROUTER_API_KEY = "test-key";
process.env.DEEPGRAM_API_KEY = "";
process.env.TIKTOK_USERNAME = "";

const { Effect, Layer, ManagedRuntime } = await import("effect");
const { Bus } = await import("../bus");
const { Window } = await import("../window");
const { Store } = await import("../store");
const { SettingsStore } = await import("../settings");
const { Gate } = await import("../gate");
const { Jev } = await import("../jev");
const { Glm } = await import("../glm");
const { Session } = await import("../session");
const { makeServer } = await import("../http");
const { LiveProbe, watcherLayer } = await import("../watch");
const { AppConfig } = await import("../config");

const t0 = 1_700_000_000_000;
mkdirSync(process.env.JEV_RECORDINGS_DIR!, { recursive: true });
const REC = "alice-2026-01-01T00-00-00-000Z";
const lines = [
  { kind: "chat", id: "m1", ts: t0, userId: "u", handle: "bob", nickname: "Bob", text: "regardez https://example.test", avatar: "https://example.test/bob.png" },
  { kind: "chat", id: "m2", ts: t0 + 1000, userId: "u", handle: "cy", nickname: "Cy", text: "salut" },
  { kind: "transcript", ts: t0 + 2000, text: "bonjour tout le monde", final: true },
];
writeFileSync(path.join(process.env.JEV_RECORDINGS_DIR!, `${REC}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
writeFileSync(path.join(process.env.JEV_RECORDINGS_DIR!, `${REC}.meta.json`), JSON.stringify({ username: "alice", startedAt: t0, videos: [], endedAt: t0 + 3000 }));

const stubJev = { decide: (_s: unknown, qs: Record<string, unknown>) => Effect.succeed({ answers: Object.fromEntries(Object.keys(qs).map((id) => [id, { type: "noul" as const, noul: 0.1 }])), latencyMs: 1, cost: 0, usage: { inputTokens: 0, outputTokens: 0, cost: 0, costConfirmed: true } }) };
let liveNow = false;
const probeCalls: string[] = [];
const probe = { isLive: (u: string) => { probeCalls.push(u); return u === "boom" ? Effect.fail(new Error("tiktok down")) : Effect.succeed(liveNow); } };
const layer = watcherLayer({ minPollMs: 200, retryAfterDropMs: 100, maxBackoffMs: 2000 }).pipe(
  Layer.provideMerge(Layer.succeed(LiveProbe, probe)),
  Layer.provideMerge(Session.Default),
  Layer.provideMerge(Layer.mergeAll(Layer.succeed(Jev, stubJev as any), Glm.Default)),
  Layer.provideMerge(Gate.Default),
  Layer.provideMerge(Layer.mergeAll(Bus.Default, Window.Default, Store.Default)),
  Layer.provideMerge(SettingsStore.Default),
);
const runtime = ManagedRuntime.make(layer);
const cfg = { ...(await runtime.runPromise(AppConfig)), port: 0, host: "127.0.0.1" };
const server = makeServer({ runtime, cfg });
const base = `http://127.0.0.1:${server.port}`;
const call = async (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const res = await fetch(base + p, { method: init.method ?? (init.body ? "POST" : "GET"), headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

// A second front door over the same runtime, with a token and tiny limits.
const guarded = makeServer({ runtime, cfg: { ...cfg, token: "s3cret" }, limits: { apiPerMinute: 8, authFailuresPer15Min: 5 } });
const gbase = `http://127.0.0.1:${guarded.port}`;
const gcall = async (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const res = await fetch(gbase + p, { method: init.method ?? (init.body ? "POST" : "GET"), headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined, redirect: "manual" });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
};

afterAll(async () => { server.stop(true); guarded.stop(true); await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("token auth, session cookie, rate limits", () => {
  test("open server: /api/auth says no token is needed and login is a no-op", async () => {
    expect((await call("/api/auth")).body).toEqual({ ok: true, required: false, authenticated: true });
    expect((await call("/api/auth/login", { body: { token: "whatever" } })).body).toEqual({ ok: true, required: false });
  });
  test("bearer, ?token= and the cookie all open the door; nothing else does", async () => {
    expect((await gcall("/api/auth")).body).toEqual({ ok: true, required: true, authenticated: false });
    expect((await gcall("/api/state")).status).toBe(401);
    expect((await gcall("/hls/live.m3u8")).status).toBe(401);
    expect((await gcall("/api/state", { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
    expect((await gcall("/api/state?token=s3cret")).status).toBe(200);
    expect((await gcall("/api/state", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    // Login: a wrong token is refused; the right one sets an HttpOnly, SameSite=Strict cookie that is not the token.
    expect((await gcall("/api/auth/login", { body: { token: "nope" } })).status).toBe(401);
    const ok = await gcall("/api/auth/login", { body: { token: "s3cret" } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^jev_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    expect(cookie).not.toContain("s3cret");
    const jar = cookie.split(";")[0];
    expect((await gcall("/api/auth", { headers: { cookie: jar } })).body.authenticated).toBe(true);
    expect((await gcall("/api/state", { headers: { cookie: jar } })).status).toBe(200);
    expect((await gcall("/api/state", { headers: { cookie: "jev_session=deadbeef" } })).status).toBe(401);
    // Behind TLS the cookie is Secure.
    const tls = await gcall("/api/auth/login", { body: { token: "s3cret" }, headers: { "x-forwarded-proto": "https" } });
    expect(tls.headers.get("set-cookie")).toContain("; Secure");
    // A cookie-authenticated write must come from this origin; reads and bearer writes are not restricted.
    expect((await gcall("/api/disconnect", { method: "POST", headers: { cookie: jar, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await gcall("/api/disconnect", { method: "POST", headers: { cookie: jar, origin: "https://evil.example" } })).status).toBe(403);
    expect((await gcall("/api/disconnect", { method: "POST", headers: { cookie: jar, origin: "not a url" } })).status).toBe(403);
    expect((await gcall("/api/disconnect", { method: "POST", headers: { cookie: jar, "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect((await gcall("/api/disconnect", { method: "POST", headers: { cookie: jar, origin: `http://127.0.0.1:${guarded.port}` } })).status).toBe(200);
    expect((await gcall("/api/disconnect", { method: "POST", headers: { authorization: "Bearer s3cret", "sec-fetch-site": "cross-site" } })).status).toBe(200);
    expect((await gcall("/api/state", { headers: { cookie: jar, "sec-fetch-site": "cross-site" } })).status).toBe(200);
    // Logout clears the cookie.
    const out = await gcall("/api/auth/logout", { method: "POST", headers: { cookie: jar } });
    expect(out.headers.get("set-cookie")).toMatch(/^jev_session=; .*Max-Age=0$/);
  });
  test("failed authentications are throttled per address, successful ones are not; the API has a request budget", async () => {
    // Each successful login reset the counter: five bad bearers fill the window, the sixth is refused: the next attempts are 429, even with the right token on login.
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await gcall("/api/state", { headers: { authorization: "Bearer bad" } })).status;
    expect(last).toBe(429);
    const blocked = await gcall("/api/auth/login", { body: { token: "s3cret" } });
    expect(blocked.status).toBe(429); expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Authenticated traffic still flows, until the per-minute budget is spent.
    let status = 200, n = 0;
    while (status === 200 && n < 20) { status = (await gcall("/api/health", { headers: { authorization: "Bearer s3cret" } })).status; n++; }
    expect(status).toBe(429); expect(n).toBeLessThanOrEqual(9);
    expect((await gcall("/hls/nothing.m3u8", { headers: { authorization: "Bearer s3cret" } })).status).toBe(404); // media is not budgeted
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("stream watcher", () => {
  test("arms from the console, polls, backs off on errors, connects when live, disarms on a manual disconnect", async () => {
    const before = (await call("/api/watch")).body;
    expect(before).toMatchObject({ armed: false, checks: 0 });
    expect((await call("/api/watch", { body: { armed: true, username: "bad name" } })).status).toBe(400);
    expect((await call("/api/watch", { body: { armed: true } })).status).toBe(422); // no username anywhere yet
    // Watch @alice: the first check runs at once; she is offline, so the next check is scheduled at the poll period.
    const armed = await call("/api/watch", { body: { armed: true, username: "@alice" } });
    expect(armed.status).toBe(200); expect(armed.body.watch).toMatchObject({ armed: true, username: "alice" });
    await sleep(150);
    let w = (await call("/api/watch")).body;
    expect(w).toMatchObject({ armed: true, lastResult: "offline", checks: 1 });
    expect(w.nextCheck - w.lastCheck).toBeGreaterThanOrEqual(200);
    expect(probeCalls).toEqual(["alice"]);
    // hello carries it too.
    expect((await call("/api/state")).body.watch.username).toBe("alice");
    // An error grows the wait.
    probeCalls.length = 0;
    await call("/api/watch", { body: { armed: true, username: "boom" } });
    await sleep(150);
    w = (await call("/api/watch")).body;
    expect(w).toMatchObject({ lastResult: "error", username: "boom" }); expect(w.detail).toContain("tiktok down");
    expect(w.nextCheck - w.lastCheck).toBeGreaterThanOrEqual(400);
    // Live: the watcher starts the session. "x" is not a valid handle, so the start is refused at once (no TikTok call)
    // and the watcher reports it, still armed. Auto-connect from the settings arms with the settings username.
    liveNow = true;
    await call("/api/settings", { method: "PUT", body: { tiktok: { username: "x", autoConnect: true } } });
    await sleep(200);
    w = (await call("/api/watch")).body;
    expect(w).toMatchObject({ armed: true, username: "x", lastResult: "error", detail: "invalid username" });
    liveNow = false;
    await call("/api/settings", { method: "PUT", body: { tiktok: { autoConnect: false } } });
    expect((await call("/api/watch")).body.armed).toBe(false);
    // A manual disconnect disarms; a replay connect disarms as well and the watcher never interrupts it.
    await call("/api/watch", { body: { armed: true, username: "alice" } });
    expect((await call("/api/disconnect", { method: "POST" })).body.ok).toBe(false); // no session, but the watcher is off
    expect((await call("/api/watch")).body.armed).toBe(false);
    await call("/api/watch", { body: { armed: true, username: "alice" } });
    expect((await call("/api/connect", { body: { username: "replay", replay: REC } })).status).toBe(200);
    expect((await call("/api/watch")).body.armed).toBe(false);
    await call("/api/disconnect", { method: "POST" });
    // Settings: auto-connect on arms with the settings username; off disarms.
    await call("/api/settings", { method: "PUT", body: { tiktok: { username: "carol", autoConnect: true } } });
    expect((await call("/api/watch")).body).toMatchObject({ armed: true, username: "carol" });
    await call("/api/settings", { method: "PUT", body: { tiktok: { autoConnect: false } } });
    expect((await call("/api/watch")).body.armed).toBe(false);
    expect((await call("/api/settings")).body.tiktok).toMatchObject({ autoConnect: false, resume: true, pollSec: 60 });
    // Stop from the console.
    await call("/api/watch", { body: { armed: true } });
    expect((await call("/api/watch")).body).toMatchObject({ armed: true, username: "carol" });
    expect((await call("/api/watch", { body: { armed: false } })).body.watch.armed).toBe(false);
  });
});

describe("rules over HTTP", () => {
  test("a keyword rule is added, edited in place (same question id), paused, and unknown ids are 404", async () => {
    const added = await call("/api/rules", { body: { text: "links", kind: "keyword", pattern: "https?://", sources: ["chat"], label: "links" } });
    expect(added.status).toBe(200);
    const id: string = added.body.rule.id;
    const qid: string = added.body.questions[0].id;
    // Edit the pattern and the label: the question keeps its id (flags stay attributable), the set moves one version.
    const v1 = (await call("/api/state")).body.questions.version;
    const edited = await call(`/api/rules/${id}`, { method: "PATCH", body: { pattern: "\\bwww\\.", label: "web links", text: "web links in chat" } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ recompiled: false, rule: { id, text: "web links in chat", kind: "keyword" } });
    expect(edited.body.questions[0]).toMatchObject({ id: qid, label: "web links", local: { pattern: "\\bwww\\.", flags: "i" } });
    const state = (await call("/api/state")).body;
    expect(state.questions.version).toBe(v1 + 1);
    expect(state.questions.questions.filter((q: any) => q.ruleId === id).length).toBe(1);
    expect(state.rules.find((r: any) => r.id === id).text).toBe("web links in chat");
    // Sources only: the question follows.
    const src = await call(`/api/rules/${id}`, { method: "PATCH", body: { sources: ["transcript"] } });
    expect(src.status).toBe(200); expect(src.body.questions[0].sources).toEqual(["transcript"]);
    // Bad edits are refused without touching anything.
    expect((await call(`/api/rules/${id}`, { method: "PATCH", body: { pattern: "(" } })).status).toBe(422);
    expect((await call(`/api/rules/${id}`, { method: "PATCH", body: { sources: [] } })).status).toBe(422);
    expect((await call(`/api/rules/${id}`, { method: "PATCH", body: {} })).status).toBe(400);
    expect((await call(`/api/rules/nope`, { method: "PATCH", body: { paused: true } })).status).toBe(404);
    expect((await call(`/api/rules/nope`, { method: "PATCH", body: { text: "x" } })).status).toBe(404);
    // Pause and an edit in one request.
    const both = await call(`/api/rules/${id}`, { method: "PATCH", body: { paused: true, label: "L" } });
    expect(both.status).toBe(200);
    const after = (await call("/api/state")).body;
    expect(after.rules.find((r: any) => r.id === id).paused).toBe(true);
    expect(after.questions.questions.find((q: any) => q.id === qid).label).toBe("L");
    // A jev rule with nothing changed is "nothing to change" (no GLM call).
    const jev = after.rules.find((r: any) => r.kind !== "keyword");
    expect((await call(`/api/rules/${jev.id}`, { method: "PATCH", body: { text: jev.text } })).status).toBe(400);
  });

  test("a pattern is tested on a recording (latest by default) with a sample carrying the author's avatar", async () => {
    const r = await call("/api/rules/test", { body: { pattern: "https?://|www\\." } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, source: { kind: "recording", id: REC, username: "alice" }, scope: "message", total: 2, matched: 1 });
    expect(r.body.sample[0]).toMatchObject({ handle: "bob", nickname: "Bob", avatar: "https://example.test/bob.png", text: "regardez https://example.test" });
    const room = await call("/api/rules/test", { body: { pattern: "bonjour", scope: "window", recording: REC } });
    expect(room.body).toMatchObject({ total: 1, matched: 1 });
    expect((await call("/api/rules/test", { body: { pattern: "(" } })).status).toBe(422);
    expect((await call("/api/rules/test", { body: { pattern: "x", recording: "missing" } })).status).toBe(404);
    expect((await call("/api/rules/test", { body: { pattern: "x", recording: "../etc" } })).status).toBe(404);
    // With a session running the test uses its events.
    const connect = await call("/api/connect", { body: { username: "replay", replay: REC } });
    expect(connect.status).toBe(200);
    const live = await call("/api/rules/test", { body: { pattern: "salut" } });
    expect(live.body).toMatchObject({ source: { kind: "session", id: REC }, matched: 1 });
    await call("/api/disconnect", { method: "POST" });
  });
});
