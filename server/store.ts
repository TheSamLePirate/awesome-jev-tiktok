import { Data, Duration, Effect, Option, Queue, Ref, Schema } from "effect";
import path from "node:path";
import type { Highlight, QuestionSet, Rule, WatchQuestion } from "../shared/protocol";
import { SEED_QUESTIONS, SEED_RULES } from "./seed";
import { atomicWrite, copy, exists, move, readJson } from "./fs";

/** Overridable so tests never touch the real runtime directory. */
const runtimeDir = () => process.env.JEV_RUNTIME_DIR ?? path.resolve("runtime");
interface Persisted { current: QuestionSet; history: QuestionSet[]; rules: Rule[]; highlights?: Highlight[] }
/** Unpinned highlights beyond this are trimmed; pinned ones are never trimmed. */
const MAX_UNPINNED = 500;
const MAX_HISTORY = 60;
/** How long a deleted highlight or rule can be restored. */
export const UNDO_MS = 60_000;

export class StaleVersion extends Data.TaggedError("StaleVersion")<{ expected: number; actual: number }> {
  get message() { return `question set changed (v${this.actual}) since v${this.expected}; not applied`; }
}

// Structural validation of the persisted file. Question internals stay `Unknown`: GLM writes them and jev reads them.
const QuestionSchema = Schema.Struct({
  id: Schema.String, label: Schema.String, ruleId: Schema.String, scope: Schema.Literal("window", "message"),
  sources: Schema.Array(Schema.Literal("transcript", "video", "chat")), question: Schema.Unknown,
  alert: Schema.optional(Schema.Unknown), local: Schema.optional(Schema.Unknown),
});
const SetSchema = Schema.Struct({ version: Schema.Number, createdAt: Schema.Number, reason: Schema.String, questions: Schema.Array(QuestionSchema), restoredFrom: Schema.optional(Schema.Number) });
const RuleSchema = Schema.Struct({ id: Schema.String, text: Schema.String, sources: Schema.Array(Schema.Literal("transcript", "video", "chat")), createdAt: Schema.Number, kind: Schema.optional(Schema.Literal("jev", "keyword")), paused: Schema.optional(Schema.Boolean) });
const HighlightSchema = Schema.Struct({ id: Schema.String, ts: Schema.Number, kind: Schema.Literal("message", "transcript", "scene", "room"), flags: Schema.Array(Schema.Unknown), pinned: Schema.Boolean, resolved: Schema.Boolean }, { key: Schema.String, value: Schema.Unknown });
const PersistedSchema = Schema.Struct({ current: SetSchema, history: Schema.Array(SetSchema), rules: Schema.Array(RuleSchema), highlights: Schema.optional(Schema.Array(HighlightSchema)) });

/** Versioned question set. Every change produces a new version so the UI can diff them. Persisted to runtime/store.json. */
export class Store extends Effect.Service<Store>()("Store", {
  scoped: Effect.gen(function* () {
    const FILE = path.join(runtimeDir(), "store.json");
    const BACKUP = path.join(runtimeDir(), "store.backup.json");
    const seed: Persisted = {
      current: { version: 1, createdAt: Date.now(), reason: "seed question set", questions: SEED_QUESTIONS },
      history: [],
      rules: SEED_RULES,
    };
    seed.history = [seed.current];

    // Load the main file; if it is corrupt, move it aside and try the rolling backup; else seed.
    const tryLoad = (file: string) => readJson(file, PersistedSchema).pipe(Effect.map((o) => (o._tag === "Some" ? (o.value as unknown as Persisted) : null)));
    const loaded = yield* tryLoad(FILE).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          const aside = `${FILE.replace(/\.json$/, "")}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
          yield* Effect.logError(`store: ${e.message}; moving it to ${path.basename(aside)} and trying the backup`);
          yield* move(FILE, aside).pipe(Effect.ignore);
          return yield* tryLoad(BACKUP).pipe(Effect.tapError((e2) => Effect.logError(`store: backup unusable too: ${e2.message}`)), Effect.orElseSucceed(() => null));
        }),
      ),
    );
    const data = loaded ?? seed;
    if (loaded) yield* Effect.logInfo(`store: loaded v${loaded.current.version} with ${loaded.rules.length} rules and ${loaded.highlights?.length ?? 0} highlights`);

    const current = yield* Ref.make<QuestionSet>(data.current);
    const history = yield* Ref.make<QuestionSet[]>(data.history);
    const rules = yield* Ref.make<Rule[]>(data.rules);
    const highlights = yield* Ref.make<Highlight[]>(data.highlights ?? []);
    const trash = yield* Ref.make<Map<string, { h: Highlight; at: number }>>(new Map());
    const ruleTrash = yield* Ref.make<Map<string, { rule: Rule; questions: WatchQuestion[]; at: number }>>(new Map());

    // One writer fiber: every mutation signals; writes are debounced, serialised and atomic, with a rolling backup.
    const dirty = yield* Queue.sliding<void>(1);
    const flush = Effect.gen(function* () {
      const snap: Persisted = { current: yield* Ref.get(current), history: yield* Ref.get(history), rules: yield* Ref.get(rules), highlights: yield* Ref.get(highlights) };
      if (yield* exists(FILE)) yield* copy(FILE, BACKUP).pipe(Effect.ignore);
      yield* atomicWrite(FILE, JSON.stringify(snap, null, 1), 0o600);
    }).pipe(Effect.tapError((e) => Effect.logError(`store: could not persist: ${e.message}`)), Effect.ignore);
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(dirty);
        yield* Effect.sleep(Duration.millis(300));
        yield* Queue.takeAll(dirty); // coalesce whatever arrived during the debounce
        yield* flush;
      }
    }).pipe(Effect.forkScoped);
    // Flush on shutdown so the last change is not lost.
    yield* Effect.addFinalizer(() => flush);
    const persist = Queue.offer(dirty, undefined).pipe(Effect.asVoid);

    const commit = (reason: string, questions: WatchQuestion[], extra: Partial<QuestionSet> = {}) =>
      Effect.gen(function* () {
        const prev = yield* Ref.get(current);
        const next: QuestionSet = { version: prev.version + 1, createdAt: Date.now(), reason, questions, ...extra };
        yield* Ref.set(current, next);
        yield* Ref.update(history, (h) => [...h.slice(-(MAX_HISTORY - 1)), next]);
        yield* persist;
        return next;
      });

    const expireTrash = Effect.gen(function* () {
      const now = Date.now();
      yield* Ref.update(trash, (m) => { for (const [k, v] of m) if (now - v.at > UNDO_MS) m.delete(k); return m; });
      yield* Ref.update(ruleTrash, (m) => { for (const [k, v] of m) if (now - v.at > UNDO_MS) m.delete(k); return m; });
    });

    return {
      current: Ref.get(current),
      history: Ref.get(history),
      rules: Ref.get(rules),
      addRule: (rule: Rule) => Ref.update(rules, (r) => [...r, rule]).pipe(Effect.andThen(persist)),
      setRulePaused: (id: string, paused: boolean) => Ref.update(rules, (r) => r.map((x) => (x.id === id ? { ...x, paused } : x))).pipe(Effect.andThen(persist)),
      /** Remove a rule and its questions; both go to a trash that `restoreRule` can bring back for UNDO_MS. */
      removeRule: (ruleId: string) =>
        Effect.gen(function* () {
          const rule = (yield* Ref.get(rules)).find((r) => r.id === ruleId);
          if (!rule) return null;
          const set = yield* Ref.get(current);
          const qs = set.questions.filter((q) => q.ruleId === ruleId);
          yield* Ref.update(rules, (r) => r.filter((x) => x.id !== ruleId));
          yield* expireTrash;
          yield* Ref.update(ruleTrash, (m) => m.set(ruleId, { rule, questions: qs, at: Date.now() }));
          const next = yield* commit(`removed rule: ${rule.text.slice(0, 60)}`, set.questions.filter((x) => x.ruleId !== ruleId));
          return { rule, questions: qs, set: next };
        }),
      restoreRule: (ruleId: string) =>
        Effect.gen(function* () {
          yield* expireTrash;
          const t = (yield* Ref.get(ruleTrash)).get(ruleId);
          if (!t) return null;
          yield* Ref.update(ruleTrash, (m) => { m.delete(ruleId); return m; });
          yield* Ref.update(rules, (r) => (r.some((x) => x.id === ruleId) ? r : [...r, t.rule]));
          const set = yield* Ref.get(current);
          const ids = new Set(set.questions.map((q) => q.id));
          const next = yield* commit(`restored rule: ${t.rule.text.slice(0, 60)}`, [...set.questions, ...t.questions.filter((q) => !ids.has(q.id))]);
          return { rule: t.rule, set: next };
        }),
      /** Append questions (compiled from a new rule). */
      append: (reason: string, qs: WatchQuestion[]) =>
        Effect.flatMap(Ref.get(current), (c) => commit(reason, [...c.questions, ...qs])),
      /**
       * Replace one question by id (refinement). `expectVersion` guards against a slow GLM answer overwriting a newer
       * change: when the set moved on, the replacement is refused with StaleVersion.
       */
      replace: (reason: string, q: WatchQuestion, expectVersion?: number) =>
        Effect.gen(function* () {
          const c = yield* Ref.get(current);
          if (expectVersion !== undefined && c.version !== expectVersion) return yield* new StaleVersion({ expected: expectVersion, actual: c.version });
          if (!c.questions.some((x) => x.id === q.id)) return yield* new StaleVersion({ expected: expectVersion ?? c.version, actual: c.version });
          return yield* commit(reason, c.questions.map((x) => (x.id === q.id ? q : x)));
        }),
      /** Restore an older version's questions as a NEW version (history stays linear and attributable). */
      restoreVersion: (version: number) =>
        Effect.gen(function* () {
          const h = yield* Ref.get(history);
          const target = h.find((s) => s.version === version);
          if (!target) return null;
          const known = new Set((yield* Ref.get(rules)).map((r) => r.id));
          // Questions whose rule was deleted since are not resurrected: a rule owns its questions.
          const qs = target.questions.filter((q) => known.has(q.ruleId));
          return yield* commit(`restored v${version}`, qs, { restoredFrom: version });
        }),
      highlights: Ref.get(highlights),
      addHighlight: (h: Highlight) =>
        Ref.update(highlights, (xs) => {
          const next = [...xs, h];
          let unpinned = next.filter((x) => !x.pinned).length;
          if (unpinned <= MAX_UNPINNED) return next;
          // Trim the oldest unpinned only; pinned items are kept whatever their number.
          return next.filter((x) => { if (x.pinned || unpinned <= MAX_UNPINNED) return true; unpinned--; return false; });
        }).pipe(Effect.andThen(persist)),
      updateHighlight: (id: string, patch: Partial<Pick<Highlight, "pinned" | "resolved">>) =>
        Ref.modify(highlights, (xs) => {
          const i = xs.findIndex((x) => x.id === id);
          if (i < 0) return [undefined, xs] as const;
          const h = { ...xs[i], ...patch };
          return [h, xs.map((x, j) => (j === i ? h : x))] as const;
        }).pipe(Effect.tap(() => persist)),
      /** Soft delete: the highlight can be restored for UNDO_MS. */
      removeHighlight: (id: string) =>
        Effect.gen(function* () {
          const h = (yield* Ref.get(highlights)).find((x) => x.id === id);
          if (!h) return false;
          yield* Ref.update(highlights, (xs) => xs.filter((x) => x.id !== id));
          yield* expireTrash;
          yield* Ref.update(trash, (m) => m.set(id, { h, at: Date.now() }));
          yield* persist;
          return true;
        }),
      restoreHighlight: (id: string) =>
        Effect.gen(function* () {
          yield* expireTrash;
          const t = (yield* Ref.get(trash)).get(id);
          if (!t) return Option.none<Highlight>();
          yield* Ref.update(trash, (m) => { m.delete(id); return m; });
          yield* Ref.update(highlights, (xs) => (xs.some((x) => x.id === id) ? xs : [...xs, t.h].sort((a, b) => a.ts - b.ts)));
          yield* persist;
          return Option.some(t.h);
        }),
      /** Clear highlights. Cleared items are restorable for UNDO_MS as well. */
      clearHighlights: (mode: "resolved" | "all") =>
        Effect.gen(function* () {
          const before = yield* Ref.get(highlights);
          const keep = (x: Highlight) => x.pinned || (mode === "resolved" ? !x.resolved : false);
          const removed = before.filter((x) => !keep(x));
          yield* Ref.set(highlights, before.filter(keep));
          yield* expireTrash;
          const now = Date.now();
          yield* Ref.update(trash, (m) => { for (const h of removed) m.set(h.id, { h, at: now }); return m; });
          yield* persist;
          return removed;
        }),
      /** Flush now (tests and shutdown). */
      flush,
    };
  }),
}) {}
