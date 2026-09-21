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
const layer = Session.Default.pipe(
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

afterAll(async () => { server.stop(true); await runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });

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
