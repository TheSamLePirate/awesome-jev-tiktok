import { Effect, Ref } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Highlight, QuestionSet, Rule, WatchQuestion } from "../shared/protocol";
import { SEED_QUESTIONS, SEED_RULES } from "./seed";

const FILE = path.resolve("runtime", "store.json");
interface Persisted { current: QuestionSet; history: QuestionSet[]; rules: Rule[]; highlights?: Highlight[] }
const MAX_HIGHLIGHTS = 500;

/** Versioned question set. Every change produces a new version so the UI can diff them. Persisted to runtime/store.json. */
export class Store extends Effect.Service<Store>()("Store", {
  effect: Effect.gen(function* () {
    const seed: Persisted = {
      current: { version: 1, createdAt: Date.now(), reason: "seed question set", questions: SEED_QUESTIONS },
      history: [],
      rules: SEED_RULES,
    };
    seed.history = [seed.current];
    const loaded = yield* Effect.tryPromise(() => readFile(FILE, "utf8").then((t) => JSON.parse(t) as Persisted)).pipe(
      Effect.tap((p) => Effect.logInfo(`store: loaded v${p.current.version} with ${p.rules.length} rules from ${FILE}`)),
      Effect.orElseSucceed(() => seed),
    );
    const current = yield* Ref.make<QuestionSet>(loaded.current);
    const history = yield* Ref.make<QuestionSet[]>(loaded.history);
    const rules = yield* Ref.make<Rule[]>(loaded.rules);
    const highlights = yield* Ref.make<Highlight[]>(loaded.highlights ?? []);

    const persist = Effect.gen(function* () {
      const data: Persisted = { current: yield* Ref.get(current), history: yield* Ref.get(history), rules: yield* Ref.get(rules), highlights: yield* Ref.get(highlights) };
      yield* Effect.promise(async () => { await mkdir(path.dirname(FILE), { recursive: true }); await writeFile(FILE, JSON.stringify(data, null, 1)); });
    }).pipe(Effect.ignore);

    const commit = (reason: string, questions: WatchQuestion[]) =>
      Effect.gen(function* () {
        const prev = yield* Ref.get(current);
        const next: QuestionSet = { version: prev.version + 1, createdAt: Date.now(), reason, questions };
        yield* Ref.set(current, next);
        yield* Ref.update(history, (h) => [...h.slice(-30), next]);
        yield* persist;
        return next;
      });

    return {
      current: Ref.get(current),
      history: Ref.get(history),
      rules: Ref.get(rules),
      addRule: (rule: Rule) => Ref.update(rules, (r) => [...r, rule]).pipe(Effect.andThen(persist)),
      removeRule: (id: string) => Ref.update(rules, (r) => r.filter((x) => x.id !== id)).pipe(Effect.andThen(persist)),
      /** Append questions (compiled from a new rule). */
      append: (reason: string, qs: WatchQuestion[]) =>
        Effect.flatMap(Ref.get(current), (c) => commit(reason, [...c.questions, ...qs])),
      /** Replace one question by id (refinement). */
      replace: (reason: string, q: WatchQuestion) =>
        Effect.flatMap(Ref.get(current), (c) => commit(reason, c.questions.map((x) => (x.id === q.id ? q : x)))),
      highlights: Ref.get(highlights),
      addHighlight: (h: Highlight) =>
        Ref.update(highlights, (xs) => {
          const next = [...xs, h];
          // Keep pinned ones; trim the oldest unpinned beyond the cap.
          if (next.length <= MAX_HIGHLIGHTS) return next;
          const idx = next.findIndex((x) => !x.pinned);
          return idx >= 0 ? next.filter((_, i) => i !== idx) : next.slice(1);
        }).pipe(Effect.andThen(persist)),
      updateHighlight: (id: string, patch: Partial<Pick<Highlight, "pinned" | "resolved">>) =>
        Ref.modify(highlights, (xs) => {
          const i = xs.findIndex((x) => x.id === id);
          if (i < 0) return [undefined, xs] as const;
          const h = { ...xs[i], ...patch };
          return [h, xs.map((x, j) => (j === i ? h : x))] as const;
        }).pipe(Effect.tap(() => persist)),
      removeHighlight: (id: string) => Ref.update(highlights, (xs) => xs.filter((x) => x.id !== id)).pipe(Effect.andThen(persist)),
      clearHighlights: (mode: "resolved" | "all") =>
        Ref.update(highlights, (xs) => xs.filter((x) => x.pinned || (mode === "resolved" ? !x.resolved : false))).pipe(Effect.andThen(persist)),
      /** Drop every question belonging to a rule. */
      dropRule: (ruleId: string) =>
        Effect.flatMap(Ref.get(current), (c) => commit(`removed rule ${ruleId}`, c.questions.filter((x) => x.ruleId !== ruleId))),
    };
  }),
}) {}
