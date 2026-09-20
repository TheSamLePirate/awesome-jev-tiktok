import { Effect, Ref, Stream, Duration, Option } from "effect";
import { SettingsStore } from "./settings";
import { Bus } from "./bus";
import { Window } from "./window";
import { Store } from "./store";
import { Jev } from "./jev";
import { Glm } from "./glm";
import type { ChatEvent, Decision, Highlight, HighlightFlag, HighlightKind, JevAnswer, JevQuestion, MessageDecision, Snapshot, WatchQuestion } from "../shared/protocol";
import { projectMessage, projectWindow, sourceKey } from "./project";
import type { JevResult } from "./jev";

export const isFired = (q: WatchQuestion, a: JevAnswer | undefined, floor = 0.4): boolean => {
  if (!a || !q.alert) return false;
  if (a.type === "noul") return q.alert.noulAbove !== undefined && a.noul >= q.alert.noulAbove;
  if (a.type === "choice") return (q.alert.choices ?? []).includes(a.choice) && a.confidence >= floor;
  if (a.type === "score") return q.alert.scoreAtLeast !== undefined && a.score >= q.alert.scoreAtLeast && a.confidence >= floor;
  return false;
};

const confidenceOf = (a: JevAnswer): number => (a.type === "noul" ? Math.abs(a.noul - 0.5) * 2 : a.confidence);

const toMap = (qs: WatchQuestion[]): Record<string, JevQuestion> => Object.fromEntries(qs.map((q) => [q.id, q.question]));

/** Questions that read different media get different states, so group them and fan the calls out in parallel. */
const groupBySources = (qs: WatchQuestion[]) => {
  const groups = new Map<string, WatchQuestion[]>();
  for (const q of qs) {
    const k = sourceKey(q.sources);
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  return [...groups.values()];
};

const merge = (results: JevResult[]): JevResult => ({
  answers: Object.assign({}, ...results.map((r) => r.answers)),
  latencyMs: Math.max(0, ...results.map((r) => r.latencyMs)),
  cost: results.reduce((a, r) => a + r.cost, 0),
  inputTokens: results.reduce((a, r) => a + r.inputTokens, 0),
  outputTokens: results.reduce((a, r) => a + r.outputTokens, 0),
});

/** The decision loops: a 1 Hz window tick, one call per chat message, and the auto-refine watchdog. */
export const runLoops = Effect.gen(function* () {
  const settings = yield* SettingsStore;
  const bus = yield* Bus;
  const win = yield* Window;
  const store = yield* Store;
  const jev = yield* Jev;
  const glm = yield* Glm;

  const tick = yield* Ref.make(0);
  const prevFired = yield* Ref.make<Set<string>>(new Set());
  const lastHighlightAt = yield* Ref.make<Record<string, number>>({});

  const flagOf = (q: WatchQuestion, a: JevAnswer): HighlightFlag => ({ questionId: q.id, ruleId: q.ruleId, label: q.label, sources: q.sources, answer: a });

  /** A room-level highlight: what the flagged question was looking at, according to its sources. */
  const windowHighlight = (qs: WatchQuestion[], answers: Record<string, JevAnswer>, snap: Snapshot) =>
    Effect.gen(function* () {
      const sources = new Set(qs.flatMap((q) => q.sources));
      const st = yield* settings.get;
      const lines = sources.has("transcript") ? (yield* win.recentTranscript(st.timing.excerptMs)).slice(-4) : [];
      const hasScene = sources.has("video") && snap.scene.length > 0;
      const hasChat = sources.has("chat") && snap.chat_recent.length > 0;
      // Nothing to show yet (stream just started): skip rather than create an empty card.
      if (!lines.length && !hasScene && !hasChat) return false;
      const kind: HighlightKind = lines.length ? "transcript" : hasScene ? "scene" : hasChat ? "room" : "room";
      const h: Highlight = {
        id: crypto.randomUUID(), ts: Date.now(), kind, pinned: false, resolved: false,
        flags: qs.map((q) => flagOf(q, answers[q.id]!)),
        transcript: lines.length ? { from: lines[0].ts, to: lines[lines.length - 1].ts, lines } : undefined,
        scene: hasScene ? { ts: snap.ts, text: snap.scene[snap.scene.length - 1] } : undefined,
        chat: hasChat ? snap.chat_recent.slice(-5) : undefined,
        activity: snap.activity,
      };
      yield* store.addHighlight(h);
      yield* bus.publish({ type: "highlight", highlight: h, fresh: true });
      return true;
    });
  // Per-question exponential moving average of confidence, plus a few low-confidence samples for GLM.
  const health = yield* Ref.make<Record<string, { ema: number; samples: unknown[]; lastRefine: number }>>({});

  // ---- window tick ----
  const windowTick = Effect.gen(function* () {
    const st = yield* settings.get;
    const set = yield* store.current;
    const qs = set.questions.filter((q) => q.scope === "window");
    const snap = yield* win.snapshot(Date.now(), st.timing.windowMs);
    yield* bus.publish({ type: "snapshot", snapshot: snap });
    if (qs.length === 0) return;
    const n = yield* Ref.updateAndGet(tick, (t) => t + 1);
    const groups = groupBySources(qs);
    const result = merge(yield* Effect.all(groups.map((g) => jev.decide(projectWindow(snap, g[0].sources), toMap(g)).pipe(
      Effect.tapError((e) => bus.log({ actor: "jev", kind: "tick", detail: `tick ${n} failed: HTTP ${e.status} ${e.body.slice(0, 80)}`, ok: false, questions: g.length })),
    )), { concurrency: 4 }));
    const fired = qs.filter((q) => isFired(q, result.answers[q.id], st.decisions.fireConfidenceFloor)).map((q) => q.id);
    const decision: Decision = { tick: n, ts: Date.now(), version: set.version, latencyMs: result.latencyMs, cost: result.cost, answers: result.answers, fired };
    yield* bus.publish({ type: "decision", decision });
    yield* bus.log({ actor: "jev", kind: "tick", detail: `tick ${n} · ${groups.length} call${groups.length > 1 ? "s" : ""}${fired.length ? ` · fired ${fired.join(", ")}` : ""}`, ok: true, latencyMs: result.latencyMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost, questions: qs.length });
    // Edge-triggered highlights: a question that just started firing, at most once per gap.
    const prev = yield* Ref.getAndSet(prevFired, new Set(fired));
    const now = Date.now();
    const gaps = yield* Ref.get(lastHighlightAt);
    const fresh = qs.filter((q) => fired.includes(q.id) && !prev.has(q.id) && now - (gaps[q.id] ?? 0) > st.timing.highlightGapMs);
    if (fresh.length) {
      const created = yield* windowHighlight(fresh, result.answers, snap);
      if (created) yield* Ref.update(lastHighlightAt, (g) => ({ ...g, ...Object.fromEntries(fresh.map((q) => [q.id, now])) }));
      // Skipped for lack of content: forget these so they count as "fresh" again once there is something to show.
      else yield* Ref.update(prevFired, (p) => { const n = new Set(p); for (const q of fresh) n.delete(q.id); return n; });
    }
    // Track confidence health for auto-refine.
    yield* Ref.update(health, (h) => {
      const next = { ...h };
      for (const q of qs) {
        const a = result.answers[q.id];
        if (!a) continue;
        const c = confidenceOf(a);
        const cur = next[q.id] ?? { ema: 0.8, samples: [], lastRefine: 0 };
        const samples = c < st.decisions.unsureBelow ? [...cur.samples.slice(-3), { state: projectWindow({ ...snap, transcript_last_30s: snap.transcript_last_30s.slice(-400), chat_recent: snap.chat_recent.slice(-5) }, q.sources), answer: a }] : cur.samples;
        next[q.id] = { ema: cur.ema * 0.9 + c * 0.1, samples, lastRefine: cur.lastRefine };
      }
      return next;
    });
  }).pipe(Effect.catchAll((e) => Effect.logWarning(`tick failed: ${JSON.stringify(e)}`)));

  // Period read from settings each loop so a tick change applies immediately.
  // Fixed-rate: the period includes the jev call, so a 1 s tick really is 1 s apart.
  yield* Effect.gen(function* () {
    while (true) {
      const t0 = Date.now();
      yield* windowTick;
      const st = yield* settings.get;
      yield* Effect.sleep(Duration.millis(Math.max(50, st.timing.tickMs - (Date.now() - t0))));
    }
  }).pipe(Effect.forkScoped);

  // ---- per-message decisions ----
  const judgeMessage = (m: ChatEvent) =>
    Effect.gen(function* () {
      const st = yield* settings.get;
      if (!st.decisions.judgeMessages) return;
      const set = yield* store.current;
      const qs = set.questions.filter((q) => q.scope === "message");
      if (qs.length === 0) return;
      const snap = yield* win.snapshot(Date.now(), st.timing.windowMs);
      const result = merge(yield* Effect.all(groupBySources(qs).map((g) => jev.decide(projectMessage(m, snap, g[0].sources), toMap(g)).pipe(
        Effect.tapError((e) => bus.log({ actor: "jev", kind: "message", detail: `@${m.handle} failed: HTTP ${e.status}`, ok: false, questions: g.length })),
      )), { concurrency: 4 }));
      const fired = qs.filter((q) => isFired(q, result.answers[q.id], st.decisions.fireConfidenceFloor)).map((q) => q.id);
      const decision: MessageDecision = { messageId: m.id, version: set.version, latencyMs: result.latencyMs, answers: result.answers, fired };
      yield* bus.publish({ type: "messageDecision", decision });
      yield* bus.log({ actor: "jev", kind: "message", detail: `@${m.handle}: ${m.text.slice(0, 80)}${fired.length ? ` · fired ${fired.join(", ")}` : ""}`, ok: true, latencyMs: result.latencyMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost, questions: qs.length });
      if (fired.length) {
        const h: Highlight = {
          id: crypto.randomUUID(), ts: Date.now(), kind: "message", pinned: false, resolved: false,
          flags: qs.filter((q) => fired.includes(q.id)).map((q) => flagOf(q, result.answers[q.id]!)),
          message: m,
          transcript: qs.some((q) => q.sources.includes("transcript")) ? (() => { const lines = snap.transcript_last_30s ? [{ ts: snap.ts, text: snap.transcript_last_30s.slice(-300) }] : []; return lines.length ? { from: snap.ts - 30_000, to: snap.ts, lines } : undefined; })() : undefined,
        };
        yield* store.addHighlight(h);
        yield* bus.publish({ type: "highlight", highlight: h, fresh: true });
      }
    }).pipe(Effect.catchAll((e) => Effect.logWarning(`message judge failed: ${JSON.stringify(e)}`)));

  yield* bus.stream.pipe(
    Stream.filterMap((msg) => (msg.type === "event" && msg.event.kind === "chat" ? Option.some(msg.event as ChatEvent) : Option.none<ChatEvent>())),
    Stream.mapEffect(judgeMessage, { concurrency: (yield* settings.get).decisions.messageConcurrency }),
    Stream.runDrain,
    Effect.forkScoped,
  );

  // ---- auto-refine watchdog: if jev stays unsure about a question, let GLM rewrite it ----
  const watchdog = Effect.gen(function* () {
    const st = yield* settings.get;
    if (!st.autoRefine.enabled) return;
    const h = yield* Ref.get(health);
    const set = yield* store.current;
    const rules = yield* store.rules;
    const now = Date.now();
    for (const q of set.questions) {
      const s = h[q.id];
      if (!s || s.ema > st.autoRefine.emaBelow || s.samples.length < st.autoRefine.minSamples || now - s.lastRefine < st.autoRefine.cooldownMs) continue;
      yield* Ref.update(health, (x) => ({ ...x, [q.id]: { ...s, lastRefine: now, ema: 0.8, samples: [] } }));
      const id = crypto.randomUUID();
      yield* bus.publish({ type: "glm", activity: { id, ts: now, kind: "auto-refine", status: "running", summary: `jev stays unsure on "${q.label}" (avg confidence ${s.ema.toFixed(2)}); asking GLM to sharpen it` } });
      const r = yield* glm.refine(q, rules.find((r) => r.id === q.ruleId), { lowConfidence: s.samples }).pipe(Effect.either);
      if (r._tag === "Left") {
        yield* bus.publish({ type: "glm", activity: { id, ts: now, kind: "auto-refine", status: "error", summary: r.left.message } });
        yield* bus.log({ actor: "glm", kind: "auto-refine", detail: `${q.label}: ${r.left.message}`, ok: false });
        continue;
      }
      yield* bus.log({ actor: "glm", kind: "auto-refine", detail: `${q.label}: ${r.right.rationale}`, ok: true, latencyMs: r.right.latencyMs, inputTokens: r.right.usage.inputTokens, outputTokens: r.right.usage.outputTokens, cost: r.right.usage.cost });
      const next = yield* store.replace(`auto-refine "${q.label}": ${r.right.rationale}`, r.right.question);
      yield* bus.publish({ type: "glm", activity: { id, ts: now, kind: "auto-refine", status: "done", summary: r.right.rationale, tokens: r.right.tokens } });
      yield* bus.publish({ type: "questions", set: next, history: yield* store.history, rules });
    }
  }).pipe(Effect.catchAll((e) => Effect.logWarning(`watchdog: ${String(e)}`)));

  yield* Effect.gen(function* () {
    while (true) {
      const st = yield* settings.get;
      yield* Effect.sleep(Duration.millis(st.autoRefine.intervalMs));
      yield* watchdog;
    }
  }).pipe(Effect.forkScoped);
});
