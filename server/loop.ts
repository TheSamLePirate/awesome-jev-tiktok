import { Effect, Ref, Stream, Duration, Option, Queue } from "effect";
import { SettingsStore } from "./settings";
import { Bus } from "./bus";
import { Window } from "./window";
import { Store } from "./store";
import { Jev } from "./jev";
import { Glm } from "./glm";
import type { ChatEvent, Decision, Highlight, HighlightFlag, HighlightKind, JevAnswer, JevQuestion, MessageDecision, Rule, Severity, Snapshot, WatchQuestion } from "../shared/protocol";
import { fingerprint, projectMessage, projectWindow, sourceKey } from "./project";
import type { JevResult } from "./jev";

export const isFired = (q: WatchQuestion, a: JevAnswer | undefined, floor = 0.4): boolean => {
  if (!a || !q.alert) return false;
  if (a.type === "noul") return q.alert.noulAbove !== undefined && a.noul >= q.alert.noulAbove;
  if (a.type === "choice") return (q.alert.choices ?? []).includes(a.choice) && a.confidence >= floor;
  if (a.type === "score") return q.alert.scoreAtLeast !== undefined && a.score >= q.alert.scoreAtLeast && a.confidence >= floor;
  return false;
};

export const confidenceOf = (a: JevAnswer): number => (a.type === "noul" ? Math.abs(a.noul - 0.5) * 2 : a.confidence);

export const toMap = (qs: WatchQuestion[]): Record<string, JevQuestion> => Object.fromEntries(qs.map((q) => [q.id, q.question]));

/** Questions that read different media get different states, so group them and fan the calls out in parallel. */
export const groupBySources = (qs: WatchQuestion[]) => {
  const groups = new Map<string, WatchQuestion[]>();
  for (const q of qs) {
    const k = sourceKey(q.sources);
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  return [...groups.values()];
};

export const merge = (results: JevResult[]): JevResult => ({
  answers: Object.assign({}, ...results.map((r) => r.answers)),
  latencyMs: Math.max(0, ...results.map((r) => r.latencyMs)),
  cost: results.reduce((a, r) => a + r.cost, 0),
  costConfirmed: results.every((r) => r.costConfirmed),
  inputTokens: results.reduce((a, r) => a + r.inputTokens, 0),
  outputTokens: results.reduce((a, r) => a + r.outputTokens, 0),
});

/** A local (keyword / regex) question answered in-process: noul 1 on match, 0 otherwise. Invalid patterns never match. */
export const evalLocal = (q: WatchQuestion, texts: string[]): JevAnswer | undefined => {
  if (!q.local) return undefined;
  try {
    const re = new RegExp(q.local.pattern, q.local.flags ?? "i");
    return { type: "noul", noul: texts.some((t) => re.test(t)) ? 1 : 0 };
  } catch { return { type: "noul", noul: 0 }; }
};

const MODERATION = /hostile|spam|scam|toxic|abuse|harass|threat|insult|slur|phish/i;
/** Moderation-like flags are warnings for the host, not prompts to reply. */
export const severityOf = (flags: HighlightFlag[], rules: Rule[]): Severity => {
  for (const f of flags) {
    if (f.answer.type === "choice" && MODERATION.test(f.answer.choice)) return "warn";
    const rule = rules.find((r) => r.id === f.ruleId);
    if (rule && /moderat|hostile|spam|scam|ban|abus|harass/i.test(rule.text) && f.answer.type !== "choice") return "warn";
  }
  return "info";
};

export interface LoopOptions { sessionId: string; mode: "live" | "replay" | "simulate"; dryRun: boolean }
export interface LoopStats { fired: Record<string, number>; highlights: number; warnings: number; ticks: number; jevCalls: number }

/** The decision loops: a 1 Hz window tick, one call per chat message, and the auto-refine watchdog. */
export const runLoops = (opts: LoopOptions) => Effect.gen(function* () {
  const settings = yield* SettingsStore;
  const bus = yield* Bus;
  const win = yield* Window;
  const store = yield* Store;
  const jev = yield* Jev;
  const glm = yield* Glm;

  const tick = yield* Ref.make(0);
  const prevFired = yield* Ref.make<Set<string>>(new Set());
  const lastHighlightAt = yield* Ref.make<Record<string, number>>({});
  const stats = yield* Ref.make<LoopStats>({ fired: {}, highlights: 0, warnings: 0, ticks: 0, jevCalls: 0 });
  /** Per source group: the fingerprint of the last state sent to jev, its answers and when. Equal state = no call. */
  const lastByGroup = yield* Ref.make<Map<string, { fp: string; answers: Record<string, JevAnswer>; at: number }>>(new Map());

  const flagOf = (q: WatchQuestion, a: JevAnswer): HighlightFlag => ({ questionId: q.id, ruleId: q.ruleId, label: q.label, sources: q.sources, answer: a });
  const activeQuestions = Effect.gen(function* () {
    const set = yield* store.current;
    const rules = yield* store.rules;
    const paused = new Set(rules.filter((r) => r.paused).map((r) => r.id));
    return { set, rules, questions: set.questions.filter((q) => !paused.has(q.ruleId)), pausedIds: set.questions.filter((q) => paused.has(q.ruleId)).map((q) => q.id) };
  });

  const publishHighlight = (h: Highlight) =>
    Effect.gen(function* () {
      yield* store.addHighlight(h);
      yield* Ref.update(stats, (s) => { s.highlights++; if (h.severity === "warn") s.warnings++; for (const f of h.flags) s.fired[f.questionId] = (s.fired[f.questionId] ?? 0) + 1; return s; });
      yield* bus.publish({ type: "highlight", highlight: h, fresh: true });
    });

  /** A room-level highlight: what the flagged question was looking at, according to its sources. */
  const windowHighlight = (qs: WatchQuestion[], answers: Record<string, JevAnswer>, snap: Snapshot, version: number, tickNo: number, rules: Rule[]) =>
    Effect.gen(function* () {
      const sources = new Set(qs.flatMap((q) => q.sources));
      const st = yield* settings.get;
      const lines = sources.has("transcript") ? (yield* win.recentTranscript(st.timing.excerptMs)).slice(-4) : [];
      const hasScene = sources.has("video") && snap.scene.length > 0;
      const hasChat = sources.has("chat") && snap.chat_recent.length > 0;
      // Nothing to show yet (stream just started): skip rather than create an empty card.
      if (!lines.length && !hasScene && !hasChat) return false;
      const kind: HighlightKind = lines.length ? "transcript" : hasScene ? "scene" : "room";
      const flags = qs.map((q) => flagOf(q, answers[q.id]!));
      const h: Highlight = {
        id: crypto.randomUUID(), ts: Date.now(), kind, pinned: false, resolved: false,
        flags,
        transcript: lines.length ? { from: lines[0].ts, to: lines[lines.length - 1].ts, lines } : undefined,
        scene: hasScene ? { ts: snap.ts, text: snap.scene[snap.scene.length - 1] } : undefined,
        chat: hasChat ? snap.chat_recent.slice(-5) : undefined,
        activity: snap.activity,
        sessionId: opts.sessionId, version, decision: { tick: tickNo },
        evidence: projectWindow(snap, [...sources]),
        severity: severityOf(flags, rules),
      };
      yield* publishHighlight(h);
      return true;
    });
  // Per-question exponential moving average of confidence, plus a few low-confidence samples for GLM.
  const health = yield* Ref.make<Record<string, { ema: number; samples: unknown[]; lastRefine: number }>>({});

  /** Ask jev for every group, tolerating a failing group: the others still produce a (partial) decision. */
  const askGroups = (groups: WatchQuestion[][], stateOf: (g: WatchQuestion[]) => unknown, label: string) =>
    Effect.gen(function* () {
      const [failures, successes] = yield* Effect.partition(groups, (g) =>
        jev.decide(stateOf(g), toMap(g)).pipe(
          Effect.map((r) => ({ group: g, r })),
          Effect.tapError((e) => bus.log({ actor: "jev", kind: label, detail: `${label} failed for [${g.map((q) => q.id).join(", ")}]: ${e.message}`, ok: false, questions: g.length, costKind: e.kind === "timeout" ? "unknown" : undefined })),
          Effect.mapError((e) => ({ group: g, e })),
        ), { concurrency: 4 });
      return { failures, successes };
    });

  // ---- window tick ----
  const windowTick = Effect.gen(function* () {
    const st = yield* settings.get;
    const { set, rules, questions, pausedIds } = yield* activeQuestions;
    const qs = questions.filter((q) => q.scope === "window");
    const snap = yield* win.snapshot(Date.now(), st.timing.windowMs);
    yield* bus.publish({ type: "snapshot", snapshot: snap });
    yield* bus.setHealth({ lastTickAt: Date.now() });
    if (qs.length === 0) return;
    const n = yield* Ref.updateAndGet(tick, (t) => t + 1);
    yield* Ref.update(stats, (s) => { s.ticks++; return s; });
    const now = Date.now();
    // Local questions cost nothing and are always evaluated.
    const answers: Record<string, JevAnswer> = {};
    const texts = [snap.transcript_last_30s, ...snap.chat_recent.map((c) => c.text)];
    for (const q of qs) if (q.local) { const a = evalLocal(q, texts); if (a) answers[q.id] = a; }
    const remote = qs.filter((q) => !q.local);
    let cost = 0, latency = 0, inTok = 0, outTok = 0, calls = 0, cached = 0, costConfirmed = true;
    const skipped: string[] = [...pausedIds.filter((id) => set.questions.find((q) => q.id === id)?.scope === "window")];
    if (opts.dryRun) {
      skipped.push(...remote.map((q) => q.id));
    } else if (remote.length) {
      // Skip a group whose business state has not changed since its last call (unless it has been too long).
      const memo = yield* Ref.get(lastByGroup);
      const toCall: WatchQuestion[][] = [];
      for (const g of groupBySources(remote)) {
        const key = sourceKey(g[0].sources) + "|" + g.map((q) => q.id).sort().join(",");
        const fp = fingerprint(snap, g[0].sources);
        const m = memo.get(key);
        if (m && m.fp === fp && now - m.at < st.timing.maxTickGapMs) { Object.assign(answers, m.answers); cached++; continue; }
        toCall.push(g);
      }
      if (toCall.length) {
        const { failures, successes } = yield* askGroups(toCall, (g) => projectWindow(snap, g[0].sources), "tick");
        for (const s of successes) {
          Object.assign(answers, s.r.answers);
          cost += s.r.cost; latency = Math.max(latency, s.r.latencyMs); inTok += s.r.inputTokens; outTok += s.r.outputTokens; calls++;
          if (!s.r.costConfirmed) costConfirmed = false;
          const key = sourceKey(s.group[0].sources) + "|" + s.group.map((q) => q.id).sort().join(",");
          yield* Ref.update(lastByGroup, (mm) => mm.set(key, { fp: fingerprint(snap, s.group[0].sources), answers: s.r.answers, at: now }));
        }
        for (const f of failures) skipped.push(...f.group.map((q) => q.id));
      }
      yield* Ref.update(stats, (s) => { s.jevCalls += calls; return s; });
    }
    const prev = yield* Ref.get(prevFired);
    // A skipped question keeps its previous state: an outage is not "no", and its return is not a new alert edge.
    const fired = qs.filter((q) => (skipped.includes(q.id) ? prev.has(q.id) : isFired(q, answers[q.id], st.decisions.fireConfidenceFloor))).map((q) => q.id);
    const decision: Decision = { tick: n, ts: Date.now(), version: set.version, latencyMs: latency, cost, answers, fired, skipped: skipped.length ? skipped : undefined, cached: calls === 0 && cached > 0 ? true : undefined, partial: skipped.some((id) => !pausedIds.includes(id)) || undefined };
    yield* bus.publish({ type: "decision", decision });
    if (calls > 0) yield* bus.log({ actor: "jev", kind: "tick", detail: `tick ${n} · ${calls} call${calls > 1 ? "s" : ""}${cached ? ` · ${cached} cached` : ""}${fired.length ? ` · fired ${fired.join(", ")}` : ""}`, ok: true, latencyMs: latency, inputTokens: inTok, outputTokens: outTok, cost, costKind: costConfirmed ? "confirmed" : "unknown", questions: remote.length });
    // Edge-triggered highlights: a question that just started firing, at most once per gap.
    yield* Ref.set(prevFired, new Set(fired));
    const gaps = yield* Ref.get(lastHighlightAt);
    const fresh = qs.filter((q) => fired.includes(q.id) && !prev.has(q.id) && !skipped.includes(q.id) && now - (gaps[q.id] ?? 0) > st.timing.highlightGapMs);
    if (fresh.length) {
      const created = yield* windowHighlight(fresh, answers, snap, set.version, n, rules);
      if (created) yield* Ref.update(lastHighlightAt, (g) => ({ ...g, ...Object.fromEntries(fresh.map((q) => [q.id, now])) }));
      // Skipped for lack of content: forget these so they count as "fresh" again once there is something to show.
      else yield* Ref.update(prevFired, (p) => { const nn = new Set(p); for (const q of fresh) nn.delete(q.id); return nn; });
    }
    // Track confidence health for auto-refine.
    yield* Ref.update(health, (h) => {
      const next = { ...h };
      for (const q of remote) {
        const a = answers[q.id];
        if (!a || skipped.includes(q.id)) continue;
        const c = confidenceOf(a);
        const cur = next[q.id] ?? { ema: 0.8, samples: [], lastRefine: 0 };
        const samples = c < st.decisions.unsureBelow ? [...cur.samples.slice(-3), { state: projectWindow({ ...snap, transcript_last_30s: snap.transcript_last_30s.slice(-400), chat_recent: snap.chat_recent.slice(-5) }, q.sources), answer: a }] : cur.samples;
        next[q.id] = { ema: cur.ema * 0.9 + c * 0.1, samples, lastRefine: cur.lastRefine };
      }
      return next;
    });
  }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`tick failed: ${c.toString().slice(0, 300)}`)));

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

  // ---- per-message decisions: bounded sliding queue, age cutoff, per-minute budget, live concurrency ----
  const st0 = yield* settings.get;
  const inbox = yield* Queue.sliding<ChatEvent>(st0.budget.chatQueue);
  const dropped = yield* Ref.make(0);
  const judgedAt = yield* Ref.make<number[]>([]);
  const active = yield* Ref.make(0);

  const judgeMessage = (m: ChatEvent) =>
    Effect.gen(function* () {
      const st = yield* settings.get;
      if (!st.decisions.judgeMessages) return;
      const { set, rules, questions, pausedIds } = yield* activeQuestions;
      const qs = questions.filter((q) => q.scope === "message");
      if (qs.length === 0) return;
      const snap = yield* win.snapshot(Date.now(), st.timing.windowMs);
      const answers: Record<string, JevAnswer> = {};
      for (const q of qs) if (q.local) { const a = evalLocal(q, [m.text]); if (a) answers[q.id] = a; }
      const remote = qs.filter((q) => !q.local);
      const skipped = [...pausedIds.filter((id) => set.questions.find((q) => q.id === id)?.scope === "message")];
      let cost = 0, latency = 0, inTok = 0, outTok = 0, calls = 0, costConfirmed = true;
      if (opts.dryRun) skipped.push(...remote.map((q) => q.id));
      else if (remote.length) {
        // Per-minute budget: beyond it the message is not judged (local rules still ran).
        const now = Date.now();
        const recent = yield* Ref.updateAndGet(judgedAt, (xs) => xs.filter((t) => now - t < 60_000));
        if (recent.length >= st.budget.chatPerMinute) {
          skipped.push(...remote.map((q) => q.id));
          yield* Ref.update(dropped, (n) => n + 1);
        } else {
          yield* Ref.update(judgedAt, (xs) => [...xs, now]);
          const { failures, successes } = yield* askGroups(groupBySources(remote), (g) => projectMessage(m, snap, g[0].sources), "message");
          for (const s of successes) { Object.assign(answers, s.r.answers); cost += s.r.cost; latency = Math.max(latency, s.r.latencyMs); inTok += s.r.inputTokens; outTok += s.r.outputTokens; calls++; if (!s.r.costConfirmed) costConfirmed = false; }
          for (const f of failures) skipped.push(...f.group.map((q) => q.id));
          yield* Ref.update(stats, (s) => { s.jevCalls += calls; return s; });
        }
      }
      const fired = qs.filter((q) => !skipped.includes(q.id) && isFired(q, answers[q.id], st.decisions.fireConfidenceFloor)).map((q) => q.id);
      const decision: MessageDecision = { messageId: m.id, version: set.version, latencyMs: latency, answers, fired, skipped: skipped.length ? skipped : undefined, partial: skipped.some((id) => !pausedIds.includes(id)) || undefined };
      yield* bus.publish({ type: "messageDecision", decision });
      if (calls > 0) yield* bus.log({ actor: "jev", kind: "message", detail: `@${m.handle}: ${m.text.slice(0, 80)}${fired.length ? ` · fired ${fired.join(", ")}` : ""}`, ok: true, latencyMs: latency, inputTokens: inTok, outputTokens: outTok, cost, costKind: costConfirmed ? "confirmed" : "unknown", questions: remote.length });
      if (fired.length) {
        const firedQs = qs.filter((q) => fired.includes(q.id));
        const flags = firedQs.map((q) => flagOf(q, answers[q.id]!));
        const h: Highlight = {
          id: crypto.randomUUID(), ts: Date.now(), kind: "message", pinned: false, resolved: false,
          flags,
          message: m,
          transcript: firedQs.some((q) => q.sources.includes("transcript")) && snap.transcript_last_30s ? { from: snap.ts - 30_000, to: snap.ts, lines: [{ ts: snap.ts, text: snap.transcript_last_30s.slice(-300) }] } : undefined,
          sessionId: opts.sessionId, version: set.version, decision: { messageId: m.id },
          evidence: projectMessage(m, snap, [...new Set(firedQs.flatMap((q) => q.sources))]),
          severity: severityOf(flags, rules),
        };
        yield* publishHighlight(h);
      }
    }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`message judge failed: ${c.toString().slice(0, 300)}`)));

  // Feed the inbox from the bus (only this session's chat). Subscribed before this function returns: no message is missed.
  const sub = yield* bus.subscribe;
  yield* Stream.fromQueue(sub).pipe(
    Stream.filterMap((msg) => (msg.type === "event" && msg.event.kind === "chat" ? Option.some(msg.event as ChatEvent) : Option.none<ChatEvent>())),
    Stream.runForEach((m) => Effect.gen(function* () {
      const st = yield* settings.get;
      const size = Math.max(0, yield* Queue.size(inbox));
      if (size >= st.budget.chatQueue) yield* Ref.update(dropped, (n) => n + 1);
      yield* Queue.offer(inbox, m);
    })),
    Effect.forkScoped,
  );
  // 16 workers; the live `messageConcurrency` setting bounds how many are judging at once.
  const worker = Effect.gen(function* () {
    while (true) {
      const m = yield* Queue.take(inbox);
      const st = yield* settings.get;
      if (Date.now() - m.ts > st.budget.chatMaxAgeMs) { yield* Ref.update(dropped, (n) => n + 1); continue; }
      // Wait for a slot; the limit can change live.
      while ((yield* Ref.get(active)) >= (yield* settings.get).decisions.messageConcurrency) yield* Effect.sleep(Duration.millis(25));
      yield* Ref.update(active, (n) => n + 1);
      yield* judgeMessage(m).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1)));
    }
  });
  for (let i = 0; i < 16; i++) yield* worker.pipe(Effect.forkScoped);
  // Backlog and drops in the health record; a summary line when messages were dropped.
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.seconds(5));
      const backlog = Math.max(0, yield* Queue.size(inbox));
      const d = yield* Ref.getAndSet(dropped, 0);
      const h = yield* bus.health;
      if (backlog !== h.chatBacklog || d) yield* bus.setHealth({ chatBacklog: backlog, chatDropped: h.chatDropped + d });
      if (d) yield* bus.log({ actor: "system", kind: "backlog", detail: `${d} chat message${d > 1 ? "s" : ""} not judged (too old, over the per-minute budget, or queue full)`, ok: false });
    }
  }).pipe(Effect.forkScoped);

  // ---- auto-refine watchdog: if jev stays unsure about a question, let GLM rewrite it (live only, never in replay) ----
  const watchdog = Effect.gen(function* () {
    const st = yield* settings.get;
    if (!st.autoRefine.enabled || opts.mode !== "live" || opts.dryRun) return;
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
      yield* bus.log({ actor: "glm", kind: "auto-refine", detail: `${q.label}: ${r.right.rationale}`, ok: true, latencyMs: r.right.latencyMs, inputTokens: r.right.usage.inputTokens, outputTokens: r.right.usage.outputTokens, cost: r.right.usage.cost, costKind: r.right.usage.costConfirmed ? "confirmed" : "unknown" });
      // The set may have moved on while GLM was thinking: never overwrite a newer change.
      const applied = yield* store.replace(`auto-refine "${q.label}": ${r.right.rationale}`, r.right.question, set.version).pipe(Effect.either);
      if (applied._tag === "Left") { yield* bus.publish({ type: "glm", activity: { id, ts: now, kind: "auto-refine", status: "error", summary: `not applied: ${applied.left.message}` } }); continue; }
      yield* bus.publish({ type: "glm", activity: { id, ts: now, kind: "auto-refine", status: "done", summary: r.right.rationale, tokens: r.right.tokens } });
      yield* bus.publish({ type: "questions", set: applied.right, history: yield* store.history, rules });
    }
  }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`watchdog: ${c.toString().slice(0, 300)}`)));

  yield* Effect.gen(function* () {
    while (true) {
      const st = yield* settings.get;
      yield* Effect.sleep(Duration.millis(st.autoRefine.intervalMs));
      yield* watchdog;
    }
  }).pipe(Effect.forkScoped);

  return { stats: Ref.get(stats) };
});
