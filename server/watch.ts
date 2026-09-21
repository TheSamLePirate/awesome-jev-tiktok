import { Context, Effect, Layer, Queue, Ref, Schema, Stream } from "effect";
import path from "node:path";
import { Bus } from "./bus";
import { Session } from "./session";
import { SettingsStore } from "./settings";
import { isLive } from "./tiktok";
import { atomicWrite, readJson } from "./fs";
import type { WatchState } from "../shared/protocol";

/** "Is @user live?" without joining the room. A tag so tests can answer without TikTok. */
export class LiveProbe extends Context.Tag("LiveProbe")<LiveProbe, { isLive: (username: string, sessionId: string) => Effect.Effect<boolean, Error> }>() {
  static readonly tiktok = Layer.succeed(LiveProbe, { isLive });
}

export interface WatcherApi {
  state: Effect.Effect<WatchState>;
  /** Start watching a username (the settings' one when omitted); checks right away. */
  arm: (username?: string, reason?: string) => Effect.Effect<WatchState>;
  disarm: (reason: string) => Effect.Effect<WatchState>;
  /** Check now instead of at the next scheduled time. */
  poke: Effect.Effect<void>;
}
export class Watcher extends Context.Tag("Watcher")<Watcher, WatcherApi>() {}

export interface WatchOptions {
  /** Floor for the poll period (settings ask for ≥ 20 s; tests go faster). */ minPollMs?: number;
  /** How soon to look again after the live we were on dropped. */ retryAfterDropMs?: number;
  /** How long an error keeps growing the wait, at most. */ maxBackoffMs?: number;
}
const file = () => path.join(process.env.JEV_RUNTIME_DIR ?? path.resolve("runtime"), "watch.json");
const Saved = Schema.Struct({ armed: Schema.Boolean, username: Schema.String });

/**
 * Keeps a live session alive across drops and restarts, and connects when a streamer goes live.
 * Armed by: a successful live connect (settings.tiktok.resume), the auto-connect setting at boot, or /api/watch.
 * Disarmed by: a manual disconnect, or /api/watch. Never runs while another session (a replay) is on.
 */
export const makeWatcher = (o: WatchOptions = {}) =>
  Effect.gen(function* () {
    const bus = yield* Bus;
    const session = yield* Session;
    const settings = yield* SettingsStore;
    const probe = yield* LiveProbe;
    const minPollMs = o.minPollMs ?? 20_000, retryAfterDropMs = o.retryAfterDropMs ?? 10_000, maxBackoffMs = o.maxBackoffMs ?? 600_000;

    const saved = yield* readJson(file(), Saved).pipe(Effect.orElseSucceed(() => ({ _tag: "None" as const })), Effect.map((r) => (r._tag === "Some" ? r.value : null)));
    const st = yield* settings.get;
    const initialUser = saved?.username || st.tiktok.username;
    const armed = !!initialUser && ((saved?.armed ?? false) || st.tiktok.autoConnect);
    const state = yield* Ref.make<WatchState>({ armed, username: initialUser, since: armed ? Date.now() : null, lastCheck: null, nextCheck: armed ? Date.now() : null, lastResult: null, checks: 0 });
    const wake = yield* Queue.sliding<void>(1);
    let errors = 0;

    const persist = Effect.flatMap(Ref.get(state), (s) => atomicWrite(file(), JSON.stringify({ armed: s.armed, username: s.username }), 0o600)).pipe(Effect.ignore);
    const publish = Effect.flatMap(Ref.get(state), (s) => bus.publish({ type: "watch", watch: s }));
    const set = (patch: Partial<WatchState>) => Ref.update(state, (s) => ({ ...s, ...patch })).pipe(Effect.andThen(publish));

    const arm = (username?: string, reason = "watch") =>
      Effect.gen(function* () {
        const name = (username ?? (yield* settings.get).tiktok.username).replace(/^@/, "").trim();
        if (!name) return yield* Ref.get(state);
        const cur = yield* Ref.get(state);
        yield* set({ armed: true, username: name, since: cur.armed && cur.username === name ? cur.since : Date.now(), nextCheck: Date.now(), lastResult: cur.username === name ? cur.lastResult : null, detail: undefined });
        yield* persist;
        errors = 0;
        if (!cur.armed || cur.username !== name) yield* bus.log({ actor: "system", kind: "watch", detail: `watching @${name}: ${reason}`, ok: true });
        yield* Queue.offer(wake, undefined);
        return yield* Ref.get(state);
      });
    const disarm = (reason: string) =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(state);
        if (cur.armed) yield* bus.log({ actor: "system", kind: "watch", detail: `stopped watching @${cur.username}: ${reason}`, ok: true });
        yield* set({ armed: false, since: null, nextCheck: null });
        yield* persist;
        return yield* Ref.get(state);
      });

    const check = Effect.gen(function* () {
      const s = yield* Ref.get(state);
      const cfg = yield* settings.get;
      const pollMs = Math.max(minPollMs, cfg.tiktok.pollSec * 1000);
      const now = Date.now();
      const live = yield* probe.isLive(s.username, cfg.tiktok.sessionId).pipe(Effect.either);
      if (live._tag === "Left") {
        errors++;
        const wait = Math.min(maxBackoffMs, pollMs * 2 ** Math.min(errors, 5));
        yield* set({ lastCheck: now, nextCheck: now + wait, lastResult: "error", detail: live.left.message, checks: s.checks + 1 });
        yield* bus.log({ actor: "system", kind: "watch", detail: `${live.left.message}; next check in ${Math.round(wait / 1000)} s`, ok: false });
        return;
      }
      errors = 0;
      if (!live.right) { yield* set({ lastCheck: now, nextCheck: now + pollMs, lastResult: "offline", detail: undefined, checks: s.checks + 1 }); return; }
      yield* set({ lastCheck: now, lastResult: "live", detail: "connecting…", checks: s.checks + 1 });
      const r = yield* session.start({ username: s.username });
      if (r.ok) yield* set({ detail: undefined, nextCheck: null });
      else { yield* set({ lastResult: "error", detail: r.error, nextCheck: now + pollMs }); yield* bus.log({ actor: "system", kind: "watch", detail: `@${s.username} is live but the connection failed: ${r.error}`, ok: false }); }
    });

    // The loop: sleep until the next check (or a wake-up), skip while any session runs, then look.
    yield* Effect.gen(function* () {
      while (true) {
        const s = yield* Ref.get(state);
        const cur = yield* session.current;
        const wait = !s.armed || s.nextCheck === null ? null : cur ? 5_000 : Math.max(0, s.nextCheck - Date.now());
        if (wait === null) yield* Queue.take(wake);
        else if (wait > 0) yield* Queue.take(wake).pipe(Effect.timeout(wait), Effect.ignore);
        const s2 = yield* Ref.get(state);
        if (!s2.armed || s2.nextCheck === null || Date.now() < s2.nextCheck) continue;
        if (yield* session.current) continue;
        yield* check.pipe(Effect.catchAllCause((c) => Effect.logWarning(`watch: ${c.toString().slice(0, 200)}`)));
      }
    }).pipe(Effect.forkScoped);

    // The live we were on ended on its own: look again soon. (A manual disconnect disarms before stopping.)
    yield* Effect.gen(function* () {
      const sub = yield* bus.subscribe;
      yield* Stream.fromQueue(sub).pipe(
        Stream.filter((m) => m.type === "event" && m.event.kind === "stream" && (m.event.state === "offline" || m.event.state === "error") && m.event.detail !== "ending…"),
        Stream.runForEach(() => Effect.gen(function* () {
          const s = yield* Ref.get(state);
          if (!s.armed || s.nextCheck !== null) return;
          yield* set({ nextCheck: Date.now() + retryAfterDropMs, detail: "stream dropped; reconnecting" });
          yield* Queue.offer(wake, undefined);
        })),
      );
    }).pipe(Effect.forkScoped);

    if (armed) yield* bus.log({ actor: "system", kind: "watch", detail: `watching @${initialUser} (${saved?.armed ? "was on before the restart" : "auto-connect is on"})`, ok: true });
    return { state: Ref.get(state), arm, disarm, poke: Queue.offer(wake, undefined).pipe(Effect.asVoid) } satisfies WatcherApi;
  });

export const watcherLayer = (o: WatchOptions = {}) => Layer.scoped(Watcher, makeWatcher(o));
