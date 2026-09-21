import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "jev-assist-"));
process.env.JEV_RUNTIME_DIR = dir;
process.env.JEV_RECORDINGS_DIR = path.join(dir, "recordings");
process.env.OPENROUTER_API_KEY = "test-key";
process.env.DEEPGRAM_API_KEY = "";
process.env.TIKTOK_USERNAME = "";

const { Effect, Layer, Scope, Exit } = await import("effect");
const { Bus } = await import("../bus");
const { Window } = await import("../window");
const { Store } = await import("../store");
const { SettingsStore } = await import("../settings");
const { Gate } = await import("../gate");
const { Jev } = await import("../jev");
const { runAssist, startPoll, endPoll, parseFaq, promiseDue, mentionsName, anomalies, retentionFacts, retentionVerdict, purgePlan } = await import("../assist");
type Highlight = import("../../shared/protocol").Highlight;
type JevQuestion = import("../../shared/protocol").JevQuestion;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("app automation helpers", () => {
  test("anomalies: repeating transcript, frozen captions, flood without flags", () => {
    const now = 10 * 60_000;
    expect(anomalies({ transcriptLines: ["hello", "hello", "Hello ", "hello"], captions: [], chatVelocity: "quiet", flagsLast5Min: 1, now })).toEqual({ transcriptRepeating: true, captionsFrozen: false, floodWithoutFlags: false });
    expect(anomalies({ transcriptLines: ["a", "b", "c", "d"], captions: [{ ts: 0, text: "desk" }, { ts: 1000, text: "desk" }], chatVelocity: "flood", flagsLast5Min: 0, now })).toEqual({ transcriptRepeating: false, captionsFrozen: true, floodWithoutFlags: true });
    expect(anomalies({ transcriptLines: [], captions: [{ ts: now - 1000, text: "desk" }, { ts: now, text: "desk" }], chatVelocity: "flood", flagsLast5Min: 2, now }).captionsFrozen).toBe(false);
  });
  test("retentionFacts buckets a summary; purgePlan takes expendable, oldest first, never the current one, until enough", () => {
    const base = { sessionId: "s", username: "u", startedAt: 0, endedAt: 2 * 60_000, reason: "ended", highlights: 0, warnings: 0, spend: 0, peakViewers: 0, chatCount: 0, transcriptCount: 0, topFired: [] };
    expect(retentionFacts(base)).toEqual({ duration: "under_3_min", chat: "none", flags: "none", peak_viewers: "none", ended: "ended" });
    expect(retentionFacts({ ...base, endedAt: 2 * 3_600_000, chatCount: 500, highlights: 9, peakViewers: 250 })).toMatchObject({ duration: "long", chat: "many", flags: "many", peak_viewers: "hundreds_or_more" });
    const list = [{ id: "cur", keep: "expendable" as const, createdAt: 1, sizeBytes: 5 }, { id: "old", keep: "expendable" as const, createdAt: 2, sizeBytes: 3 }, { id: "keep", keep: "keep" as const, createdAt: 3, sizeBytes: 9 }, { id: "new", keep: "expendable" as const, createdAt: 4, sizeBytes: 3 }, { id: "untagged", createdAt: 5, sizeBytes: 9 }];
    expect(purgePlan(list, 4, "cur")).toEqual(["old", "new"]);
    expect(purgePlan(list, 1, "cur")).toEqual(["old"]);
    expect(purgePlan(list, 100, null)).toEqual(["cur", "old", "new"]);
    expect(purgePlan([], 5, null)).toEqual([]);
  });
});

describe("assist helpers", () => {
  test("parseFaq accepts => and |, skips junk, caps at 40", () => {
    const e = parseFaq("Quel horaire ? => Tous les soirs 21h\n\n  where are you from | Lyon\nno separator here\n=> empty question\n" + Array.from({ length: 50 }, (_, i) => `q${i} => a${i}`).join("\n"));
    expect(e.slice(0, 2)).toEqual([{ id: "f1", question: "Quel horaire ?", answer: "Tous les soirs 21h" }, { id: "f2", question: "where are you from", answer: "Lyon" }]);
    expect(e.length).toBe(40);
  });
  test("promiseDue reads minutes, hours, seconds in French and English", () => {
    expect(promiseDue("le giveaway dans 5 minutes", 0)).toBe(300_000);
    expect(promiseDue("I'll show it in 2 h", 0)).toBe(7_200_000);
    expect(promiseDue("dans 30 s je reviens", 0)).toBe(30_000);
    expect(promiseDue("in an hour we start", 0)).toBe(3_600_000);
    expect(promiseDue("in a minute", 0)).toBe(60_000);
    expect(promiseDue("later tonight", 0)).toBeNull();
  });
  test("mentionsName matches the handle, the nickname or their first word, never a two-letter name", () => {
    expect(mentionsName("merci beaucoup Marie Dupont pour la rose", "marie.dupont92", "Marie Dupont")).toBe(true);
    expect(mentionsName("thanks so much marie_dupont92", "marie_dupont92")).toBe(true);
    expect(mentionsName("thanks everyone", "al", "Al")).toBe(false);
    expect(mentionsName("thank you", "bob", "Bobby")).toBe(false);
  });
});

/** A scripted jev: answers by question id, records what it was asked. */
const asked: { state: unknown; ids: string[] }[] = [];
let script: Record<string, number | string> = {};
const stubJev = {
  decide: (state: unknown, qs: Record<string, JevQuestion>) => {
    asked.push({ state, ids: Object.keys(qs) });
    const answers = Object.fromEntries(Object.entries(qs).map(([id, q]) => {
      const v = script[id] ?? (id.startsWith("same_as_") ? script.same_as : undefined) ?? 0;
      return [id, q.type === "choice" ? { type: "choice", choice: String(v || "none"), probabilities: {}, confidence: 0.9 } : { type: "noul", noul: Number(v) }];
    }));
    return Effect.succeed({ answers, latencyMs: 1, cost: 0.00003, costConfirmed: true, inputTokens: 1, outputTokens: 1 });
  },
};
const layer = Layer.mergeAll(Layer.succeed(Jev, stubJev as any), Gate.Default).pipe(Layer.provideMerge(Layer.mergeAll(Bus.Default, Window.Default, Store.Default)), Layer.provideMerge(SettingsStore.Default));
const sleep = (ms: number) => Effect.promise(() => new Promise((r) => setTimeout(r, ms)));
const msgHl = (id: string, handle: string, text: string, ts = Date.now()): Highlight => ({ id, ts, kind: "message", flags: [{ questionId: "q", ruleId: "r", label: "Question", sources: ["chat"], answer: { type: "noul", noul: 0.9 } }], message: { kind: "chat", id: `c-${id}`, ts, userId: "u", handle, nickname: handle, text }, pinned: false, resolved: false, sessionId: "s1", severity: "info" });

describe("assist runner", () => {
  test("dedupe folds a same question, FAQ attaches a prepared answer, a gift becomes a thanks task closed by the host's words, a promise becomes a task, a poll counts first votes", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* Bus; const store = yield* Store; const win = yield* Window; const settings = yield* SettingsStore;
      yield* settings.update({ assist: { faqText: "what time do you stream => every night at 9pm\nwhere are you from | Lyon" } });
      yield* bus.beginSession("s1");
      const scope = yield* Scope.make();
      yield* runAssist({ sessionId: "s1", mode: "live", dryRun: false, timing: { speechDebounceMs: 150, thanksTtlMs: 100_000, answerWindowMs: 600_000 } }).pipe(Scope.extend(scope));
      const add = (h: Highlight) => Effect.gen(function* () { yield* store.addHighlight(h); yield* bus.publish({ type: "highlight", highlight: h, fresh: true }); });
      const hl = (id: string) => Effect.map(store.highlights, (hs) => hs.find((h) => h.id === id)!);

      // 1) first prompt: nothing to compare with; FAQ says entry f1.
      script = { faq: "f1" };
      yield* add(msgHl("h1", "amy", "what time do you usually go live?"));
      yield* sleep(80);
      expect((yield* hl("h1")).assist).toEqual({ kind: "faq", question: "what time do you stream", answer: "every night at 9pm" });
      expect(asked.at(-1)!.ids).toEqual(["faq"]);
      // 2) a second prompt asking the same: folded into h1, never sent to the FAQ.
      script = { same_as: 0.9, faq: "f2" };
      asked.length = 0;
      yield* add(msgHl("h2", "bob", "when are you live?"));
      yield* sleep(80);
      expect(asked.map((a) => a.ids[0])).toEqual(["same_as_h1"]);
      expect((yield* hl("h2"))).toMatchObject({ resolved: true, resolvedBy: "duplicate", duplicateOf: "h1" });
      expect((yield* hl("h1")).duplicates).toEqual({ ids: ["h2"], handles: ["bob"] });
      // Same author again is never a duplicate candidate; a low score keeps it open.
      script = { same_as: 0.2, faq: "none" };
      yield* add(msgHl("h3", "amy", "and the price?"));
      yield* sleep(80);
      expect((yield* hl("h3")).resolved).toBe(false); expect((yield* hl("h3")).assist).toBeUndefined();
      // 3) gifts: below the diamond floor nothing; above it a task; the same gifter again updates it.
      yield* settings.update({ assist: { thanksMinDiamonds: 5 } });
      yield* bus.event({ kind: "gift", id: "g0", ts: Date.now(), handle: "cheap", giftName: "Rose", count: 1, diamonds: 1 });
      yield* bus.event({ kind: "gift", id: "g1", ts: Date.now(), handle: "rich.guy", nickname: "Rich Guy", giftName: "Lion", count: 1, diamonds: 30 });
      yield* bus.event({ kind: "gift", id: "g2", ts: Date.now(), handle: "rich.guy", nickname: "Rich Guy", giftName: "Rose", count: 2, diamonds: 1 });
      yield* sleep(50);
      const tasks = (yield* store.highlights).filter((h) => h.assist?.kind === "thanks");
      expect(tasks.length).toBe(1);
      expect(tasks[0].assist).toMatchObject({ kind: "thanks", handle: "rich.guy", gift: "Rose", count: 3, diamonds: 32 });
      // 4) the host speaks: says the gifter's name (closes the thanks without a call), answers amy (jev), and promises.
      script = { answered: 0.9, promise: 0.9, thanked: 0 };
      asked.length = 0;
      const t = Date.now();
      for (const e of [{ kind: "transcript" as const, ts: t, text: "thank you rich guy for the lion, amazing", final: true }, { kind: "transcript" as const, ts: t + 10, text: "amy I go live every night at nine, and in 5 minutes we do the giveaway", final: true }]) { yield* win.ingest(e); yield* bus.event(e); }
      yield* sleep(600);
      expect((yield* hl(tasks[0].id))).toMatchObject({ resolved: true, resolvedBy: "thanked" });
      expect((yield* hl("h1"))).toMatchObject({ resolved: true, resolvedBy: "answered" });
      expect((yield* hl("h3"))).toMatchObject({ resolved: true, resolvedBy: "answered" });
      const promise = (yield* store.highlights).find((h) => h.assist?.kind === "promise")!;
      expect(promise.assist).toMatchObject({ kind: "promise", text: expect.stringContaining("giveaway") });
      expect((promise.assist as any).dueAt).toBeGreaterThan(t + 290_000);
      expect(asked.some((a) => a.ids[0] === "thanked")).toBe(false);
      // A second, identical speech batch does not create the same promise twice.
      yield* bus.event({ kind: "transcript", ts: t + 20, text: " ", final: true });
      yield* bus.event({ kind: "transcript", ts: t + 30, text: "ok", final: true });
      yield* sleep(600);
      expect((yield* store.highlights).filter((h) => h.assist?.kind === "promise").length).toBe(1);
      // 5) poll: first vote per viewer counts, "none" and low-confidence are not votes, ended polls ignore chat.
      const poll = yield* startPoll(" Pizza or burger? ", ["pizza", "burger"]);
      expect(poll.options).toEqual(["pizza", "burger"]);
      // The judge runs asynchronously: let each vote be read before the script changes.
      script = { vote: "o2" };
      yield* bus.event({ kind: "chat", id: "v1", ts: Date.now(), userId: "u", handle: "amy", nickname: "Amy", text: "burger!!" });
      yield* bus.event({ kind: "chat", id: "v2", ts: Date.now(), userId: "u", handle: "amy", nickname: "Amy", text: "burger again" });
      yield* sleep(60);
      script = { vote: "none" };
      yield* bus.event({ kind: "chat", id: "v3", ts: Date.now(), userId: "u", handle: "cy", nickname: "Cy", text: "hello" });
      yield* sleep(60);
      script = { vote: "o1" };
      yield* bus.event({ kind: "chat", id: "v4", ts: Date.now(), userId: "u", handle: "dee", nickname: "Dee", text: "1" });
      yield* sleep(80);
      let p = (yield* bus.poll)!;
      expect(p).toMatchObject({ counts: { burger: 1, pizza: 1 }, voters: 2, judged: 3 });
      expect(p.recent.map((r) => `${r.handle}:${r.option}`)).toEqual(["amy:burger", "dee:pizza"]);
      const ended = (yield* endPoll)!;
      expect(ended.endedAt).not.toBeNull();
      yield* bus.event({ kind: "chat", id: "v5", ts: Date.now(), userId: "u", handle: "ed", nickname: "Ed", text: "pizza" });
      yield* sleep(50);
      p = (yield* bus.poll)!;
      expect(p.voters).toBe(2);
      expect(yield* endPoll).toMatchObject({ id: ended.id }); // ending twice is a no-op
      // 6) the assist budget: a tiny cap stops the helpers with one log line.
      yield* settings.update({ assist: { sessionUsd: 0.00001 } });
      asked.length = 0;
      yield* add(msgHl("h9", "zed", "what time do you stream?"));
      yield* sleep(80);
      expect(asked.length).toBe(0);
      expect((yield* bus.recentLog).some((l) => l.detail.includes("assist budget"))).toBe(true);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(layer))));
  });
  test("a dry run never calls jev and settings can switch each helper off", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* Bus; const store = yield* Store; const settings = yield* SettingsStore;
      yield* settings.update({ assist: { sessionUsd: 1, thanks: false, dedupe: false, faq: false, autoResolve: false, promises: false } });
      yield* bus.beginSession("s2");
      const scope = yield* Scope.make();
      yield* runAssist({ sessionId: "s2", mode: "replay", dryRun: true, timing: { speechDebounceMs: 100 } }).pipe(Scope.extend(scope));
      asked.length = 0;
      script = { same_as: 0.9, faq: "f1", answered: 0.9, promise: 0.9 };
      yield* store.addHighlight(msgHl("d1", "amy", "hello?")); yield* bus.publish({ type: "highlight", highlight: msgHl("d1", "amy", "hello?"), fresh: true });
      yield* bus.event({ kind: "gift", id: "g9", ts: Date.now(), handle: "x", giftName: "Rose", count: 1, diamonds: 100 });
      yield* bus.event({ kind: "transcript", ts: Date.now(), text: "in 5 minutes a giveaway, thanks x", final: true });
      yield* sleep(400);
      expect(asked.length).toBe(0);
      expect((yield* store.highlights).filter((h) => h.sessionId === "s2" && h.assist).length).toBe(0);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(layer))));
  });
  test("ops: regime, budget alert and degradation, repair applied once per cooldown, interruptibility, rule hygiene; retention verdict", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const bus = yield* Bus; const store = yield* Store; const win = yield* Window; const settings = yield* SettingsStore;
      yield* settings.update({ assist: { sessionUsd: 1, thanks: true, dedupe: true, faq: true, autoResolve: true, promises: true }, budget: { sessionUsd: 0.01 } });
      yield* bus.beginSession("s3");
      const repairs: string[] = [];
      const ops = { restartMedia: Effect.sync(() => { repairs.push("restart"); return true; }), disableTranscription: Effect.sync(() => { repairs.push("mute"); return true; }) };
      const scope = yield* Scope.make();
      // A calm room: only the regime question is asked (budget under 60 %, no trouble).
      script = { regime: "calm", degrade: "keep_all", repair: "none", interruptible: "busy" };
      asked.length = 0;
      yield* runAssist({ sessionId: "s3", mode: "live", dryRun: false, ops, timing: { opsIntervalMs: 120, interruptMs: 100, hygieneMs: 100_000, repairCooldownMs: 300 } }).pipe(Scope.extend(scope));
      yield* sleep(200);
      expect(asked.find((a) => a.ids.includes("regime"))!.ids).toEqual(["regime"]);
      expect((yield* bus.assist).regime).toBe("calm");
      // No speech: interruptible is "free" without a call.
      expect((yield* bus.assist).interruptible).toBe("free");
      expect(asked.some((a) => a.ids.includes("interruptible"))).toBe(false);
      // Spend most of the budget: the 80 % alert fires once, jev picks a degradation level.
      yield* bus.log({ actor: "jev", kind: "tick", detail: "x", ok: true, cost: 0.0085 });
      script = { regime: "hot", degrade: "pause_vision", repair: "none", interruptible: "busy" };
      yield* sleep(150);
      let a = yield* bus.assist;
      expect(a).toMatchObject({ regime: "hot", degrade: 1, budgetAlert: true }); expect(a.degradeReason).toContain("pause vision");
      expect((yield* bus.recentLog).filter((l) => l.detail.startsWith("80 % of the session budget")).length).toBe(1);
      script = { regime: "hot", degrade: "room_only", repair: "none" };
      yield* sleep(150);
      expect((yield* bus.assist).degrade).toBe(2);
      // Trouble in the pipeline: jev picks a restart, applied once; the second time within the cooldown is only suggested.
      yield* bus.setHealth({ ffmpeg: "exited" });
      script = { regime: "hot", degrade: "room_only", repair: "restart_media" };
      yield* sleep(150);
      a = yield* bus.assist;
      expect(a.repair).toMatchObject({ action: "restart_media", applied: true }); expect(repairs).toEqual(["restart"]);
      yield* sleep(130);
      expect((yield* bus.assist).repair).toMatchObject({ action: "restart_media", applied: false, detail: "media restart suggested" }); expect(repairs).toEqual(["restart"]);
      // After the cooldown, disabling transcription is applied; "alert" and "reconnect" are only suggested.
      yield* sleep(400);
      script = { regime: "hot", degrade: "room_only", repair: "disable_transcription" };
      yield* sleep(300);
      // (a second restart may have been applied meanwhile once the cooldown passed; the mute comes after it)
      expect(repairs.at(-1)).toBe("mute"); expect(repairs.filter((r) => r === "mute").length).toBe(1);
      script = { regime: "hot", degrade: "room_only", repair: "alert" };
      yield* sleep(150);
      expect((yield* bus.assist).repair).toMatchObject({ action: "alert", applied: false });
      // Recovered: the repair clears.
      yield* bus.setHealth({ ffmpeg: "running" });
      script = { regime: "normal", degrade: "keep_all" };
      yield* sleep(150);
      expect((yield* bus.assist).repair).toMatchObject({ action: "none", detail: "recovered" });
      // The host talks: interruptibility is judged from the speech.
      const t = Date.now();
      yield* win.ingest({ kind: "transcript", ts: t, text: "so let me tell you the whole story of how this started because it matters", final: true });
      script = { regime: "normal", degrade: "keep_all", interruptible: "busy" };
      yield* sleep(150);
      expect((yield* bus.assist).interruptible).toBe("busy");
      yield* Scope.close(scope, Exit.void);
      // Rule hygiene: every rule with questions gets a verdict; only non-keep ones are kept as advice, with the facts.
      const scope2 = yield* Scope.make();
      yield* store.recordFeedback("hype", "wrong"); yield* store.recordFeedback("hype", "wrong");
      script = { hype: "refine" };
      asked.length = 0;
      yield* runAssist({ sessionId: "s3", mode: "live", dryRun: false, timing: { opsIntervalMs: 100_000, interruptMs: 100_000, hygieneMs: 100 } }).pipe(Scope.extend(scope2));
      yield* sleep(250);
      const call = asked.find((x) => x.ids.includes("r-hype"))!;
      expect(call.ids.length).toBe((yield* store.rules).length);
      expect((call.state as any).rules["r-hype"]).toMatchObject({ kind: "jev", paused: false, verdicts: { wrong: 2, missed: 0, correct: 0 }, fires_this_session: "none" });
      const advice = (yield* bus.assist).ruleAdvice;
      expect(Object.keys(advice)).toEqual([]); // the script answered by question id, so every rule id got "none": not an advice
      yield* Scope.close(scope2, Exit.void);
      // A verdict answered by rule id lands in the advice.
      const scope3 = yield* Scope.make();
      script = { "r-hype": "pause", "r-host-question": "keep", "r-respond": "remove" };
      yield* runAssist({ sessionId: "s3", mode: "live", dryRun: false, timing: { opsIntervalMs: 100_000, interruptMs: 100_000, hygieneMs: 100 } }).pipe(Scope.extend(scope3));
      yield* sleep(250);
      const adv = (yield* bus.assist).ruleAdvice;
      expect(adv["r-hype"]).toMatchObject({ advice: "pause" }); expect(adv["r-hype"].reason).toContain("2 wrong");
      expect(adv["r-respond"]?.advice).toBe("remove"); expect(adv["r-host-question"]).toBeUndefined();
      yield* Scope.close(scope3, Exit.void);
      // Retention verdict through the same stub.
      script = { keep: "expendable" };
      const v = yield* retentionVerdict(stubJev as any, { sessionId: "s3", username: "u", startedAt: 0, endedAt: 60_000, reason: "ended", highlights: 0, warnings: 0, spend: 0, peakViewers: 0, chatCount: 0, transcriptCount: 0, topFired: [] });
      expect(v).toEqual({ keep: "expendable", reason: "under 3 min · chat none · flags none · viewers none" });
      const failing = { decide: () => Effect.fail(new Error("down")) };
      expect(yield* retentionVerdict(failing as any, { sessionId: "s3", username: "u", startedAt: 0, endedAt: 60_000, reason: "ended", highlights: 0, warnings: 0, spend: 0, peakViewers: 0, chatCount: 0, transcriptCount: 0, topFired: [] })).toBeNull();
    }).pipe(Effect.provide(layer))));
  });
});
