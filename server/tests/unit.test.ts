import { describe, expect, test } from "bun:test";
import { Effect, Stream, TestClock, TestContext, Fiber } from "effect";
import { applyPatch, defaultsFrom, toBool } from "../settings";
import { fingerprint, projectMessage, projectWindow } from "../project";
import { evalLocal, groupBySources, isFired, merge, severityOf } from "../loop";
import { replayEvents, searchEvents, momentContext, bucketize, testPattern } from "../replay";
import { parseRange, sessionCookieValue } from "../http";
import { RateLimiter } from "../ratelimit";
import { validateAlert } from "../glm";
import type { AppConfig } from "../config";
import type { LiveEvent, Snapshot, WatchQuestion } from "../../shared/protocol";

const cfg: AppConfig = { openrouterKey: "k", deepgramKey: "d", tiktokUsername: "u", tiktokSessionId: "", port: 1, host: "127.0.0.1", token: "", replay: "", jevModel: "j", glmModel: "g", visionModel: "v", tickMs: 1000, captionEveryMs: 6000 };

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  ts: 1000, transcript_last_30s: "", scene: [], chat_recent: [],
  activity: { chat_velocity: "silent", viewers: 12, viewers_trend: "flat", likes_last_30s: "none", gifts_last_60s: [], new_joins_last_30s: "none" },
  sources: { transcript: { state: "available", ageMs: 100 }, video: { state: "available", ageMs: 100 }, chat: { state: "available", ageMs: 100 } },
  ...over,
});

describe("settings", () => {
  const base = defaultsFrom(cfg);
  test("boolean strings are coerced, not truthy-cast", () => {
    expect(toBool("false")).toBe(false);
    expect(toBool("off")).toBe(false);
    expect(applyPatch(base, { media: { vision: "false" } }).media.vision).toBe(false);
    expect(applyPatch(base, { media: { vision: 0 } }).media.vision).toBe(false);
    expect(applyPatch(base, { media: { vision: "yes" } }).media.vision).toBe(true);
  });
  test("numbers are clamped and masked secrets untouched", () => {
    const n = applyPatch(base, { timing: { tickMs: 1 }, keys: { openrouter: "••••abcd" }, budget: { sessionUsd: -5 } });
    expect(n.timing.tickMs).toBe(250);
    expect(n.keys.openrouter).toBe("k");
    expect(n.budget.sessionUsd).toBe(0);
  });
  test("unknown keys and sections are ignored", () => {
    const n = applyPatch(base, { nope: { x: 1 }, timing: { nope: 5 } } as any);
    expect((n as any).nope).toBeUndefined();
    expect((n.timing as any).nope).toBeUndefined();
  });
});

describe("projection", () => {
  test("silence vs audio unavailable", () => {
    expect(projectWindow(snap(), ["transcript"]).host_speech_last_30s).toBe("(silence)");
    const down = snap({ sources: { transcript: { state: "error", ageMs: 5000, error: "x" }, video: { state: "missing", ageMs: -1 }, chat: { state: "available", ageMs: 1 } } });
    expect(projectWindow(down, ["transcript"]).host_speech_last_30s).toBe("(audio unavailable)");
    expect(projectWindow(down, ["video"]).video_scene).toEqual(["(video unavailable)"]);
    expect(projectMessage({ kind: "chat", id: "1", ts: 1, userId: "u", handle: "h", nickname: "n", text: "hi" }, down, ["transcript"]).context.host_speech_last_30s).toBe("(audio unavailable)");
  });
  test("chat-less projections do not leak chat", () => {
    const p = projectWindow(snap({ chat_recent: [{ handle: "a", text: "b", secs_ago: 1 }] }), ["transcript"]);
    expect(p.chat_recent).toBeUndefined();
    expect((p.activity as any).chat_velocity).toBeUndefined();
  });
  test("fingerprint ignores secs_ago, viewers and timestamps but sees content and expiry", () => {
    const a = snap({ chat_recent: [{ handle: "a", text: "hello", secs_ago: 1 }] });
    const b = snap({ ts: 2000, chat_recent: [{ handle: "a", text: "hello", secs_ago: 5 }], activity: { ...a.activity, viewers: 99 } });
    expect(fingerprint(a, ["chat"])).toBe(fingerprint(b, ["chat"]));
    const c = snap({ chat_recent: [] });
    expect(fingerprint(a, ["chat"])).not.toBe(fingerprint(c, ["chat"]));
    expect(fingerprint(a, ["transcript"])).toBe(fingerprint(c, ["transcript"]));
  });
});

describe("decisions", () => {
  const q = (over: Partial<WatchQuestion>): WatchQuestion => ({ id: "q", label: "Q", ruleId: "r", scope: "window", sources: ["chat"], question: { type: "noul", instructions: "?" }, ...over });
  test("isFired honours thresholds and the confidence floor", () => {
    expect(isFired(q({ alert: { noulAbove: 0.7 } }), { type: "noul", noul: 0.71 })).toBe(true);
    expect(isFired(q({ alert: { noulAbove: 0.7 } }), { type: "noul", noul: 0.69 })).toBe(false);
    expect(isFired(q({ alert: { choices: ["spam"] } }), { type: "choice", choice: "spam", probabilities: {}, confidence: 0.3 }, 0.4)).toBe(false);
    expect(isFired(q({ alert: { choices: ["spam"] } }), { type: "choice", choice: "spam", probabilities: {}, confidence: 0.5 }, 0.4)).toBe(true);
    expect(isFired(q({ alert: { scoreAtLeast: 2 } }), { type: "score", score: 2.1, legend: {}, probabilities: {}, confidence: 0.9 })).toBe(true);
    expect(isFired(q({}), { type: "noul", noul: 1 })).toBe(false);
  });
  test("groupBySources and merge", () => {
    const groups = groupBySources([q({ id: "a", sources: ["chat"] }), q({ id: "b", sources: ["transcript", "chat"] }), q({ id: "c", sources: ["chat", "transcript"] })]);
    expect(groups.length).toBe(2);
    expect(groups[1].map((x) => x.id)).toEqual(["b", "c"]);
    const m = merge([{ answers: { a: { type: "noul", noul: 1 } }, latencyMs: 100, cost: 0.1, costConfirmed: true, inputTokens: 1, outputTokens: 2 }, { answers: { b: { type: "noul", noul: 0 } }, latencyMs: 300, cost: 0.2, costConfirmed: false, inputTokens: 3, outputTokens: 4 }]);
    expect(Object.keys(m.answers)).toEqual(["a", "b"]);
    expect(m.latencyMs).toBe(300); expect(m.cost).toBeCloseTo(0.3); expect(m.costConfirmed).toBe(false); expect(m.inputTokens).toBe(4);
  });
  test("local keyword questions never call jev and survive bad patterns", () => {
    const kw = q({ local: { pattern: "\\b(prix|price)\\b", flags: "i" } });
    expect(evalLocal(kw, ["Quel est le PRIX ?"])).toEqual({ type: "noul", noul: 1 });
    expect(evalLocal(kw, ["hello"])).toEqual({ type: "noul", noul: 0 });
    expect(evalLocal(q({ local: { pattern: "(" } }), ["("])).toEqual({ type: "noul", noul: 0 });
    expect(evalLocal(q({}), ["x"])).toBeUndefined();
  });
  test("severity: moderation choices are warnings", () => {
    const flag = { questionId: "q", ruleId: "r", label: "Safety", sources: ["chat" as const], answer: { type: "choice" as const, choice: "hostile", probabilities: {}, confidence: 0.9 } };
    expect(severityOf([flag], [])).toBe("warn");
    expect(severityOf([{ ...flag, answer: { type: "choice", choice: "fine", probabilities: {}, confidence: 0.9 } }], [])).toBe("info");
    expect(severityOf([{ ...flag, answer: { type: "noul", noul: 1 } }], [{ id: "r", text: "Flag spam in chat", sources: ["chat"], createdAt: 0 }])).toBe("warn");
  });
  test("validateAlert rejects alerts that cannot fire", () => {
    expect(validateAlert({ id: "a", label: "A", scope: "window", question: { type: "choice", instructions: "?", criteria: { x: "1", y: "2" } }, alert: { choices: ["z"] } })).toMatch(/not among/);
    expect(validateAlert({ id: "a", label: "A", scope: "window", question: { type: "score", instructions: "?", criteria: ["1", "2"] }, alert: { scoreAtLeast: 2 } })).toMatch(/0\.\.1/);
    expect(validateAlert({ id: "a", label: "A", scope: "window", question: { type: "noul", instructions: "?" }, alert: { noulAbove: 0.5 } })).toBeNull();
  });
});

describe("replay", () => {
  const events: LiveEvent[] = [
    { kind: "transcript", ts: 1000, endTs: 1100, text: "bonjour", final: true },
    { kind: "chat", id: "c1", ts: 1300, userId: "u", handle: "bob", nickname: "Bob", text: "salut le prix ?" },
    { kind: "transcript", ts: 2000, endTs: 2500, text: "c'est dix euros", final: true },
  ];
  test("replayEvents keeps spacing and shifts endTs by the same delta (S5 + audit C)", async () => {
    const program = Effect.gen(function* () {
      const out: LiveEvent[] = [];
      const clock = yield* Effect.clock;
      const nowMs = () => Number(clock.unsafeCurrentTimeMillis());
      const fiber = yield* replayEvents(events, 0, nowMs).pipe(Stream.runForEach((e) => Effect.sync(() => { out.push(e); })), Effect.fork);
      yield* TestClock.adjust("0 millis");
      yield* TestClock.adjust("300 millis");
      yield* TestClock.adjust("700 millis");
      yield* Fiber.join(fiber);
      return out;
    }).pipe(Effect.provide(TestContext.TestContext));
    const out = await Effect.runPromise(program);
    expect(out.length).toBe(3);
    expect(out[1].ts - out[0].ts).toBe(300);
    expect(out[2].ts - out[0].ts).toBe(1000);
    const t0 = out[0] as Extract<LiveEvent, { kind: "transcript" }>;
    expect(t0.endTs! - t0.ts).toBe(100);
    const t2 = out[2] as Extract<LiveEvent, { kind: "transcript" }>;
    expect(t2.endTs! - t2.ts).toBe(500);
    expect(out[0].srcTs).toBe(1000);
  });
  test("offset skips earlier events", async () => {
    const real = await Effect.runPromise(replayEvents(events, 500, Date.now).pipe(Stream.runCollect, Effect.map((c) => [...c])));
    expect(real.map((e) => e.srcTs)).toEqual([2000]);
    const none = await Effect.runPromise(replayEvents(events, 5000, Date.now).pipe(Stream.runCollect, Effect.map((c) => [...c])));
    expect(none).toEqual([]);
  });
  test("search, context and buckets", () => {
    const hits = searchEvents(events, "PRIX", ["chat", "transcript"]);
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe("chat");
    expect(hits[0].offsetMs).toBe(300);
    expect(searchEvents(events, "", ["chat"])).toEqual([]);
    const ctx = momentContext(events, 1300, 1000);
    expect(ctx.chat.length).toBe(1);
    expect(ctx.transcript.map((t) => t.text)).toEqual(["bonjour", "c'est dix euros"]);
    const b = bucketize(events, 1000, 2000, 2);
    expect(b.buckets.reduce((a, x) => a + x.chat + x.transcript, 0)).toBe(3);
  });
  test("testPattern counts matches per scope and returns a bounded sample with the author", () => {
    const chat = testPattern(events, "prix", "i", "message");
    expect(chat).toMatchObject({ total: 1, matched: 1 });
    expect(chat.sample[0]).toMatchObject({ handle: "bob", nickname: "Bob", text: "salut le prix ?" });
    const room = testPattern(events, "euros|bonjour", "gi", "window", 1);
    expect(room).toMatchObject({ total: 2, matched: 2 });
    expect(room.sample.length).toBe(1); expect(room.sample[0].handle).toBeUndefined();
    expect(testPattern(events, "nothing", "i", "message")).toMatchObject({ total: 1, matched: 0, sample: [] });
  });
});

describe("rate limiter", () => {
  test("fixed window per key: allows the limit, then refuses with a retry-after until the window turns", () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.hit("a", 0)).toEqual({ ok: true, remaining: 2, retryAfterSec: 0 });
    expect(rl.hit("a", 10).ok).toBe(true); expect(rl.hit("a", 20).ok).toBe(true);
    expect(rl.hit("a", 30)).toEqual({ ok: false, remaining: 0, retryAfterSec: 1 });
    expect(rl.blocked("a", 40)).toEqual({ blocked: true, retryAfterSec: 1 });
    expect(rl.blocked("b", 40)).toEqual({ blocked: false, retryAfterSec: 0 });
    expect(rl.hit("b", 40).ok).toBe(true);
    expect(rl.hit("a", 1000).ok).toBe(true); // new window
    expect(rl.blocked("a", 1001).blocked).toBe(false);
    rl.reset("a"); expect(rl.hit("a", 1002).remaining).toBe(2);
    // Memory stays bounded: old windows are swept once the map is large.
    const big = new RateLimiter(1, 100);
    for (let i = 0; i < 10_001; i++) big.hit(`k${i}`, 0);
    big.hit("late", 1000);
    expect((big as any).hits.size).toBe(1);
  });
  test("the session cookie is derived from the token, never the token itself", () => {
    expect(sessionCookieValue("secret")).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionCookieValue("secret")).not.toBe(sessionCookieValue("secret2"));
    expect(sessionCookieValue("secret")).toBe(sessionCookieValue("secret"));
  });
});

describe("http ranges (RFC 7233)", () => {
  test("parseRange", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-1000", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=0-1000", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-2", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });
});
