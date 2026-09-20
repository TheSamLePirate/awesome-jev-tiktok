import { Effect, Ref } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QuestionSet, Rule, WatchQuestion } from "../shared/protocol";
import { SEED_QUESTIONS, SEED_RULES } from "./seed";

const FILE = path.resolve("runtime", "store.json");
interface Persisted { current: QuestionSet; history: QuestionSet[]; rules: Rule[] }

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

    const persist = Effect.gen(function* () {
      const data: Persisted = { current: yield* Ref.get(current), history: yield* Ref.get(history), rules: yield* Ref.get(rules) };
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
      /** Drop every question belonging to a rule. */
      dropRule: (ruleId: string) =>
        Effect.flatMap(Ref.get(current), (c) => commit(`removed rule ${ruleId}`, c.questions.filter((x) => x.ruleId !== ruleId))),
    };
  }),
}) {}
