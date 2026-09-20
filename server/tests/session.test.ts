import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "jev-session-"));
process.env.JEV_RUNTIME_DIR = dir;
process.env.JEV_RECORDINGS_DIR = path.join(dir, "recordings");
process.env.OPENROUTER_API_KEY = "test-key";
process.env.DEEPGRAM_API_KEY = "";

const { Effect, Layer, Stream, Duration, Fiber, Ref } = await import("effect");
const { Bus } = await import("../bus");
const { Window } = await import("../window");
const { Store } = await import("../store");
const { SettingsStore } = await import("../settings");
const { Gate } = await import("../gate");
const { Jev } = await import("../jev");
const { Glm } = await import("../glm");
const { Session } = await import("../session");
type ServerMessage = import("../../shared/protocol").ServerMessage;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A 40 s recording with a chat line every 2 s, so a replay stays alive long enough to observe its loops.
const t0 = 1_700_000_000_000;
mkdirSync(process.env.JEV_RECORDINGS_DIR!, { recursive: true });
const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ kind: "chat", id: `m${i}`, ts: t0 + i * 2000, userId: "u", handle: "bob", nickname: "Bob", text: `hello ${i}` }));
writeFileSync(path.join(process.env.JEV_RECORDINGS_DIR!, "rec-2026-01-01T00-00-00-000Z.jsonl"), lines.join("\n") + "\n");
writeFileSync(path.join(process.env.JEV_RECORDINGS_DIR!, "rec-2026-01-01T00-00-00-000Z.meta.json"), JSON.stringify({ username: "rec", startedAt: t0, videos: [], endedAt: t0 + 40_000 }));

const stubJev = { decide: (_s: unknown, qs: Record<string, unknown>) => Effect.succeed({ answers: Object.fromEntries(Object.keys(qs).map((id) => [id, { type: "noul" as const, noul: 0.1 }])), latencyMs: 1, cost: 0, costConfirmed: true, inputTokens: 0, outputTokens: 0 }) };
const layer = Session.Default.pipe(
  Layer.provideMerge(Layer.mergeAll(Layer.succeed(Jev, stubJev as any), Glm.Default)),
  Layer.provideMerge(Gate.Default),
  Layer.provideMerge(Layer.mergeAll(Bus.Default, Window.Default, Store.Default)),
  Layer.provideMerge(SettingsStore.Default),
);

describe("Session lifecycle", () => {
  test("stopping a session (or replacing it) interrupts its loops: no decision is published afterwards", async () => {
    const r = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const session = yield* Session;
      const bus = yield* Bus;
      const settings = yield* SettingsStore;
      yield* settings.update({ timing: { tickMs: 250 } });
      const seen = yield* Ref.make<ServerMessage[]>([]);
      const sub = yield* bus.stream.pipe(Stream.runForEach((m) => Ref.update(seen, (xs) => [...xs, m])), Effect.fork);
      const started = yield* session.start({ replayId: "rec-2026-01-01T00-00-00-000Z" });
      expect(started.ok).toBe(true);
      yield* Effect.sleep(Duration.millis(900));
      const during = (yield* Ref.get(seen)).filter((m) => m.type === "decision").length;
      // Replace the session with a second replay, then stop that one too.
      const again = yield* session.start({ replayId: "rec-2026-01-01T00-00-00-000Z", offsetMs: 2000 });
      expect(again.ok).toBe(true);
      yield* Effect.sleep(Duration.millis(900));
      const ticksOfSecond = (yield* Ref.get(seen)).filter((m) => m.type === "decision").map((m) => (m as any).decision.tick);
      const stopped = yield* session.stop("test");
      expect(stopped.ok).toBe(true);
      const atStop = (yield* Ref.get(seen)).filter((m) => m.type === "decision").length;
      yield* Effect.sleep(Duration.millis(1200));
      const after = (yield* Ref.get(seen)).filter((m) => m.type === "decision").length;
      const status = yield* session.status;
      yield* Fiber.interrupt(sub);
      return { during, ticksOfSecond, atStop, after, status: status.state };
    }).pipe(Effect.provide(layer))));
    expect(r.during).toBeGreaterThan(0);
    // The second session's tick numbers restart from 1: only one loop is alive, the first one was interrupted.
    const late = r.ticksOfSecond.slice(-3);
    expect(Math.max(...late)).toBeLessThan(8);
    expect(r.after).toBe(r.atStop);
    expect(r.status).toBe("offline");
  });
});
