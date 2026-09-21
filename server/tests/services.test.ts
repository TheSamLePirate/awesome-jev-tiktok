import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the runtime directory BEFORE the modules read their paths.
const dir = mkdtempSync(path.join(tmpdir(), "jev-test-"));
process.env.JEV_RUNTIME_DIR = dir;
process.env.JEV_RECORDINGS_DIR = path.join(dir, "recordings");
process.env.OPENROUTER_API_KEY = "test-key";
process.env.DEEPGRAM_API_KEY = "";

const { Effect, Layer, Scope, Exit, Stream, Duration, Fiber, Ref } = await import("effect");
const { Store } = await import("../store");
const { SettingsStore } = await import("../settings");
const { Bus } = await import("../bus");
const { Window } = await import("../window");
const { Gate } = await import("../gate");
const { Jev } = await import("../jev");
const { Glm } = await import("../glm");
const { runLoops } = await import("../loop");
type JevApi = import("../jev").JevApi;
type ServerMessage = import("../../shared/protocol").ServerMessage;
type Highlight = import("../../shared/protocol").Highlight;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hl = (id: string, pinned = false): Highlight => ({ id, ts: Date.now(), kind: "room", flags: [], pinned, resolved: false });

describe("Store persistence", () => {
  test("writes atomically with mode 600, keeps a backup, recovers from a corrupt file", async () => {
    const file = path.join(dir, "store.json");
    // 1) a fresh store persists after a mutation
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* Store;
      yield* store.addHighlight(hl("h1"));
      yield* store.flush;
    }).pipe(Effect.provide(Store.Default))));
    expect(existsSync(file)).toBe(true);
    expect((statSync(file).mode & 0o777)).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).highlights.length).toBe(1);
    // 2) a second run finds it and writes a backup on the next persist
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* Store;
      expect((yield* store.highlights).length).toBe(1);
      yield* store.addHighlight(hl("h2"));
      yield* store.flush;
    }).pipe(Effect.provide(Store.Default))));
    expect(existsSync(path.join(dir, "store.backup.json"))).toBe(true);
    // 3) truncate the main file mid-write: boot moves it aside and loads the backup (the previous flush: 2 highlights), not the seed (0)
    writeFileSync(file, readFileSync(file, "utf8").slice(0, 40));
    const n = await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const store = yield* Store; return (yield* store.highlights).length; }).pipe(Effect.provide(Store.Default))));
    expect(n).toBe(2);
    expect(readFileSync(path.join(dir, "store.json"), "utf8").length).toBeGreaterThan(40);
    expect(existsSync(file)).toBe(true); // rewritten by the flush on shutdown
  });
  test("pinned highlights are never trimmed; deletes are undoable; version restore creates a new version", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* Store;
      for (let i = 0; i < 520; i++) yield* store.addHighlight(hl(`p${i}`, true));
      for (let i = 0; i < 520; i++) yield* store.addHighlight(hl(`u${i}`, false));
      const all = yield* store.highlights;
      expect(all.filter((h) => h.pinned).length).toBe(520);
      expect(all.filter((h) => !h.pinned).length).toBe(500);
      expect(yield* store.removeHighlight("p1")).toBe(true);
      expect((yield* store.highlights).some((h) => h.id === "p1")).toBe(false);
      const back = yield* store.restoreHighlight("p1");
      expect(back._tag).toBe("Some");
      expect((yield* store.highlights).some((h) => h.id === "p1")).toBe(true);
      const v1 = yield* store.current;
      const v2 = yield* store.append("add", [{ id: "zz", label: "Z", ruleId: "r-hype", scope: "window", sources: ["chat"], question: { type: "noul", instructions: "?" } }]);
      expect(v2.version).toBe(v1.version + 1);
      const v3 = yield* store.restoreVersion(v1.version);
      expect(v3!.version).toBe(v2.version + 1);
      expect(v3!.restoredFrom).toBe(v1.version);
      expect(v3!.questions.some((q) => q.id === "zz")).toBe(false);
      // stale replace is refused
      const stale = yield* store.replace("x", v1.questions[0], v1.version).pipe(Effect.either);
      expect(stale._tag).toBe("Left");
      // Editing a rule keeps its id, kind and paused state; its questions are replaced where the first one stood.
      yield* store.setRulePaused("r-hype", true);
      yield* store.updateRule("r-hype", { text: "Track the mood.", sources: ["chat"] });
      const edited = (yield* store.rules).find((r) => r.id === "r-hype")!;
      expect(edited).toMatchObject({ text: "Track the mood.", sources: ["chat"], paused: true, createdAt: 0 });
      const before = yield* store.current;
      const at = before.questions.findIndex((q) => q.ruleId === "r-hype");
      const v4 = yield* store.setRuleQuestions("edit", "r-hype", [{ id: "mood2", label: "M", ruleId: "r-hype", scope: "window", sources: ["chat"], question: { type: "noul", instructions: "?" } }]);
      expect(v4.version).toBe(before.version + 1);
      expect(v4.questions.findIndex((q) => q.id === "mood2")).toBe(at);
      expect(v4.questions.filter((q) => q.ruleId === "r-hype").length).toBe(1);
      expect(v4.questions.length).toBe(before.questions.length - before.questions.filter((q) => q.ruleId === "r-hype").length + 1);
      const v5 = yield* store.setRuleQuestions("edit", "r-none", [{ id: "tail", label: "T", ruleId: "r-none", scope: "window", sources: ["chat"], question: { type: "noul", instructions: "?" } }]);
      expect(v5.questions.at(-1)?.id).toBe("tail");
    }).pipe(Effect.provide(Store.Default))));
  });
});

describe("Settings persistence", () => {
  test("secrets equal to the environment are not written to disk; file is 0600", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const s = yield* SettingsStore;
      const pub = yield* s.update({ timing: { tickMs: 2000 }, keys: { openrouter: "test-key" } });
      expect(pub.timing.tickMs).toBe(2000);
    }).pipe(Effect.provide(SettingsStore.Default)));
    const file = path.join(dir, "settings.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.settings.timing.tickMs).toBe(2000);
    expect(saved.settings.keys).toBeUndefined();
    expect((statSync(file).mode & 0o777)).toBe(0o600);
  });
});

// ---- integration: loops with a stub jev, a fake stream, and a scope that must take every fiber with it ----
const stubJev = (calls: { n: number }, fail = false): JevApi => ({
  decide: (_state, questions) =>
    Effect.gen(function* () {
      calls.n++;
      if (fail) return yield* Effect.fail(new (await_import_JevError())({ status: 500, body: "boom", retryable: false }));
      const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: 0.9 }]));
      return { answers, latencyMs: 5, cost: 0.00001, costConfirmed: true, inputTokens: 1, outputTokens: 1 };
    }),
});
let JevErrorCtor: any;
const await_import_JevError = () => JevErrorCtor;
beforeAll(async () => { JevErrorCtor = (await import("../jev")).JevError; });

const baseLayer = () => Layer.mergeAll(Bus.Default, Window.Default, Store.Default).pipe(Layer.provideMerge(SettingsStore.Default));

describe("loops (integration)", () => {
  test("a stub jev answers, highlights are created, and nothing runs after the scope closes", async () => {
    const calls = { n: 0 };
    const layer = Layer.mergeAll(Layer.succeed(Jev, stubJev(calls) as any), Glm.Default).pipe(Layer.provideMerge(Gate.Default), Layer.provideMerge(baseLayer()));
    const result = await Effect.runPromise(Effect.gen(function* () {
      const bus = yield* Bus;
      const win = yield* Window;
      const settings = yield* SettingsStore;
      yield* settings.update({ timing: { tickMs: 250, highlightGapMs: 0 }, budget: { sessionUsd: 0 } });
      const seen = yield* Ref.make<ServerMessage[]>([]);
      const sub = yield* bus.stream.pipe(Stream.runForEach((m) => Ref.update(seen, (xs) => [...xs, m])), Effect.fork);
      const scope = yield* Scope.make();
      yield* runLoops({ sessionId: "t", mode: "live", dryRun: false }).pipe(Scope.extend(scope));
      // A chat message goes through the inbox; the window gets some speech.
      yield* win.ingest({ kind: "transcript", ts: Date.now(), endTs: Date.now(), text: "hello chat, what do you think?", final: true });
      yield* bus.event({ kind: "chat", id: "m1", ts: Date.now(), userId: "u", handle: "bob", nickname: "Bob", text: "how much is it?" });
      yield* Effect.sleep(Duration.millis(900));
      const before = yield* Ref.get(seen);
      yield* Scope.close(scope, Exit.void);
      const callsAtClose = calls.n;
      yield* Effect.sleep(Duration.millis(700));
      const after = yield* Ref.get(seen);
      yield* Fiber.interrupt(sub);
      return { before, after, callsAtClose, callsAfter: calls.n };
    }).pipe(Effect.provide(layer)));
    const decisions = result.before.filter((m) => m.type === "decision");
    const msgDecisions = result.before.filter((m) => m.type === "messageDecision");
    const highlights = result.before.filter((m) => m.type === "highlight");
    expect(decisions.length).toBeGreaterThan(0);
    expect(msgDecisions.length).toBe(1);
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.every((m) => m.type === "highlight" && m.highlight.sessionId === "t" && m.highlight.evidence !== undefined)).toBe(true);
    // identical state → cached ticks, so jev is called far less than once per tick
    const cached = decisions.filter((m) => m.type === "decision" && m.decision.cached).length;
    expect(cached).toBeGreaterThan(0);
    // after the scope closed: no new decision and no new jev call
    expect(result.after.filter((m) => m.type === "decision").length).toBe(decisions.length);
    expect(result.callsAfter).toBe(result.callsAtClose);
  });

  test("a failing source group yields a partial decision and skipped ids, never a false negative", async () => {
    const calls = { n: 0 };
    const layer = Layer.mergeAll(Layer.succeed(Jev, stubJev(calls, true) as any), Glm.Default).pipe(Layer.provideMerge(Gate.Default), Layer.provideMerge(baseLayer()));
    const decisions = await Effect.runPromise(Effect.gen(function* () {
      const bus = yield* Bus;
      const settings = yield* SettingsStore;
      yield* settings.update({ timing: { tickMs: 250 }, budget: { sessionUsd: 0 } });
      const seen = yield* Ref.make<ServerMessage[]>([]);
      const sub = yield* bus.stream.pipe(Stream.runForEach((m) => Ref.update(seen, (xs) => [...xs, m])), Effect.fork);
      const scope = yield* Scope.make();
      yield* runLoops({ sessionId: "t2", mode: "live", dryRun: false }).pipe(Scope.extend(scope));
      yield* Effect.sleep(Duration.millis(600));
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.interrupt(sub);
      return (yield* Ref.get(seen)).filter((m) => m.type === "decision");
    }).pipe(Effect.provide(layer)));
    expect(decisions.length).toBeGreaterThan(0);
    const d = decisions[0] as Extract<ServerMessage, { type: "decision" }>;
    expect(d.decision.partial).toBe(true);
    expect(d.decision.skipped!.length).toBeGreaterThan(0);
    expect(d.decision.fired).toEqual([]);
    expect(Object.keys(d.decision.answers)).toEqual([]);
  });

  test("session budget stops paid calls through the gate", async () => {
    const calls = { n: 0 };
    const layer = Layer.mergeAll(Jev.Default, Glm.Default).pipe(Layer.provideMerge(Gate.Default), Layer.provideMerge(baseLayer()));
    const r = await Effect.runPromise(Effect.gen(function* () {
      const gate = yield* Gate;
      const bus = yield* Bus;
      const settings = yield* SettingsStore;
      yield* settings.update({ budget: { sessionUsd: 0.5 } });
      yield* bus.log({ actor: "jev", kind: "tick", detail: "spent", ok: true, cost: 0.49 });
      const first = yield* gate.admit(0.005).pipe(Effect.either);
      const second = yield* gate.admit(0.02).pipe(Effect.either);
      const health = yield* bus.health;
      return { first: first._tag, second: second._tag, stopped: health.budget.stopped, err: second._tag === "Left" ? second.left.kind : null };
    }).pipe(Effect.provide(layer)));
    void calls;
    expect(r.first).toBe("Right");
    expect(r.second).toBe("Left");
    expect(r.err).toBe("budget");
    expect(r.stopped).toBe(true);
  });
});
