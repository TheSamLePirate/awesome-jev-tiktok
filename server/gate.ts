import { Data, Duration, Effect, Ref } from "effect";
import { Bus } from "./bus";
import { SettingsStore } from "./settings";

/**
 * Everything that reaches OpenRouter goes through here:
 *  - one shared "not before" gate that honours 429 / Retry-After, so a limited call is not retried by every loop at once
 *  - a circuit breaker on 401 / 402: a bad key or an empty balance stops every paid call and is shown in the UI
 *  - budget admission: a call reserves an estimated cost before it starts and settles the real one after
 *  - an AbortSignal on every fetch, so a timed-out request is really cancelled instead of billed later
 */
export class GateError extends Data.TaggedError("GateError")<{ kind: "breaker" | "budget" | "timeout" | "network"; message: string }> {}

const BREAKER_MS = 5 * 60_000;

export class Gate extends Effect.Service<Gate>()("Gate", {
  effect: Effect.gen(function* () {
    const bus = yield* Bus;
    const settings = yield* SettingsStore;
    const notBefore = yield* Ref.make(0);
    const backoff = yield* Ref.make(0);
    const breaker = yield* Ref.make<{ until: number; reason: string } | null>(null);
    const stopped = yield* Ref.make(false);

    const publishHealth = Effect.gen(function* () {
      const b = yield* Ref.get(breaker);
      const nb = yield* Ref.get(notBefore);
      const t = yield* bus.totals;
      const st = yield* settings.get;
      const cap = st.budget.sessionUsd;
      const isStopped = (yield* Ref.get(stopped)) || (cap > 0 && t.session >= cap);
      yield* Ref.set(stopped, isStopped);
      yield* bus.setHealth({ breaker: b && b.until > Date.now() ? b : null, rateLimitedUntil: nb > Date.now() ? nb : 0, budget: { spent: t.session, cap, stopped: isStopped } });
    });

    /** Refuse when the breaker is open or the session budget is spent; otherwise wait for the rate-limit gate. */
    const admit = (estimatedUsd: number) =>
      Effect.gen(function* () {
        const b = yield* Ref.get(breaker);
        if (b && b.until > Date.now()) return yield* new GateError({ kind: "breaker", message: `paused: ${b.reason}` });
        const st = yield* settings.get;
        const t = yield* bus.totals;
        const cap = st.budget.sessionUsd;
        if (cap > 0 && t.session + t.reserved + estimatedUsd > cap) {
          const was = yield* Ref.getAndSet(stopped, true);
          if (!was) { yield* bus.log({ actor: "system", kind: "budget", detail: `session budget of $${cap.toFixed(2)} reached; paid calls stop (recording continues)`, ok: false }); yield* publishHealth; }
          return yield* new GateError({ kind: "budget", message: `session budget of $${cap.toFixed(2)} reached` });
        }
        const nb = yield* Ref.get(notBefore);
        const wait = nb - Date.now();
        if (wait > 0) yield* Effect.sleep(Duration.millis(Math.min(wait, 60_000)));
        yield* bus.reserve(estimatedUsd);
      });

    const settle = (estimatedUsd: number) => bus.reserve(-estimatedUsd);

    /** Report a provider response so the gate and breaker learn from it. */
    const report = (status: number, headers?: Headers) =>
      Effect.gen(function* () {
        if (status === 429) {
          const ra = Number(headers?.get("retry-after") ?? 0);
          const n = yield* Ref.updateAndGet(backoff, (x) => Math.min(60_000, x ? x * 2 : 2000));
          const until = Date.now() + (ra > 0 ? ra * 1000 : n);
          yield* Ref.update(notBefore, (x) => Math.max(x, until));
          yield* bus.log({ actor: "system", kind: "rate-limit", detail: `OpenRouter 429: paid calls paused for ${Math.round((until - Date.now()) / 1000)} s`, ok: false });
          yield* publishHealth;
        } else if (status === 401 || status === 402) {
          const reason = status === 401 ? "OpenRouter rejected the API key (401)" : "OpenRouter reports no credit (402)";
          const cur = yield* Ref.get(breaker);
          yield* Ref.set(breaker, { until: Date.now() + BREAKER_MS, reason });
          if (!cur || cur.until < Date.now()) yield* bus.log({ actor: "system", kind: "breaker", detail: `${reason}; paid calls paused for ${BREAKER_MS / 60_000} min (fix the key or the balance in Settings)`, ok: false });
          yield* publishHealth;
        } else if (status >= 200 && status < 300) {
          const had = yield* Ref.get(backoff);
          if (had) { yield* Ref.set(backoff, 0); yield* publishHealth; }
        }
      });

    /** fetch with a hard timeout that aborts the request, mapped to a typed error. */
    const fetchWithTimeout = (url: string, init: RequestInit, timeoutMs: number) =>
      Effect.tryPromise({
        try: (signal) => {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
          signal.addEventListener("abort", () => ctl.abort());
          return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t));
        },
        catch: (e) => new GateError({ kind: /timeout|abort/i.test(String((e as Error)?.message ?? e)) ? "timeout" : "network", message: String((e as Error)?.message ?? e) }),
      }).pipe(Effect.tap((res) => report(res.status, res.headers)));

    /** Manual reset: a key change in Settings closes the breaker immediately. */
    const reset = Effect.all([Ref.set(breaker, null), Ref.set(notBefore, 0), Ref.set(backoff, 0), Ref.set(stopped, false)], { discard: true }).pipe(Effect.andThen(publishHealth));

    return { admit, settle, report, fetchWithTimeout, reset, publishHealth, isStopped: Ref.get(stopped) };
  }),
}) {}
