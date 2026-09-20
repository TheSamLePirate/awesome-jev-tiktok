import { Context, Deferred, Effect, Exit, Fiber, Ref, Scope, Stream, SynchronizedRef } from "effect";
import path from "node:path";
import { Bus } from "./bus";
import { Window } from "./window";
import { Store } from "./store";
import { SettingsStore } from "./settings";
import { Gate } from "./gate";
import { Jev } from "./jev";
import { Glm } from "./glm";
import { connectTikTok } from "./tiktok";
import { runMedia, runRecorder, stopProcess, finalizeMp4, probeDuration, hlsDir, type MediaHandle } from "./media";
import { runLoops, type LoopStats } from "./loop";
import { openRecorder, replayEvents, replayBuckets, writeMeta, readMeta, recordingSpan, loadEvents, statsOf, interruptedRecordings, recordingPath, isSafeId, recordingsDir, type RecordingMeta, type Recorder } from "./replay";
import { exists, remove, diskFree } from "./fs";
import type { LiveEvent, RecordingState, ReplayInfo, ServerMessage, SessionSummary, StreamStatusEvent, VideoSegment, VideoSource } from "../shared/protocol";

export type SessionMode = "live" | "replay" | "simulate";
export interface StartRequest { username?: string; replayId?: string; offsetMs?: number; simulate?: boolean }

interface Current {
  id: string;
  scope: Scope.CloseableScope;
  username: string;
  /** recordings/<user>-<time> (no extension) for this session's files. */
  base: string;
  mode: SessionMode;
  flvUrl: string | null;
  meta: RecordingMeta;
  startedAt: number;
  /** Video segment currently being written by its own ffmpeg. */
  rec: { proc: Bun.Subprocess; file: string; startTs: number } | null;
  finalizing: number;
  /** When this session is a replay: the id of the recording it plays, its events, and the fiber feeding them. */
  replayOf?: string;
  replayEvents?: LiveEvent[];
  streamFiber: Fiber.RuntimeFiber<void, never> | null;
  recorder: Recorder | null;
  stats: Effect.Effect<LoopStats> | null;
  mediaScope: Scope.CloseableScope | null;
  mediaRestarts: number;
  stopping: boolean;
}

const MAX_MEDIA_RESTARTS = 3;

/**
 * Owner of the one live session. All transitions (start, stop, seek) run under a single permit; every callback that
 * could fire late (stream end, ffmpeg exit, finalize) checks it still talks about the current session before acting.
 * States: idle → connecting → live → stopping → idle, with `error` as a terminal status of a session.
 */
export class Session extends Effect.Service<Session>()("Session", {
  scoped: Effect.gen(function* () {
    const bus = yield* Bus;
    const win = yield* Window;
    const store = yield* Store;
    const settings = yield* SettingsStore;
    const gate = yield* Gate;
    const jev = yield* Jev;
    const glm = yield* Glm;
    void jev; void glm;
    const cfg = yield* settings.get;
    /**
     * Services the media pipeline and the loops need, captured once so forked fibers can be provided explicitly.
     * The service's own Scope is removed: with it, `forkScoped` inside the loops would attach to this long-lived
     * scope and every session would leak its tick loop. Each session provides its own scope instead.
     */
    const ctx = Context.omit(Scope.Scope)(yield* Effect.context<SettingsStore | Bus | Window | Gate | Store | Jev | Glm | Scope.Scope>());

    const current = yield* SynchronizedRef.make<Current | null>(null);
    const lock = yield* Effect.makeSemaphore(1);
    const status = yield* Ref.make<StreamStatusEvent>({ kind: "stream", ts: Date.now(), state: "offline", username: cfg.tiktok.username });
    const video = yield* Ref.make<VideoSource | null>(null);
    const replayInfo = yield* Ref.make<ReplayInfo | null>(null);
    const lastSummary = yield* Ref.make<SessionSummary | null>(null);

    const recordingState = (s: Current | null): RecordingState => ({
      active: !!s?.rec, file: s?.rec?.file, since: s?.rec?.startTs, segments: s?.meta.videos.length ?? 0, finalizing: (s?.finalizing ?? 0) > 0,
      sessionId: s && s.mode !== "replay" ? s.id : undefined, replayOf: s?.replayOf,
    });
    const publishRecording = Effect.flatMap(SynchronizedRef.get(current), (s) => bus.publish({ type: "recording", recording: recordingState(s) }));

    /** Status updates are gated on session identity: a late callback from an old session cannot flip the label. */
    const setStatus = (me: Current | null, patch: Partial<StreamStatusEvent>) =>
      Effect.gen(function* () {
        const cur = yield* SynchronizedRef.get(current);
        if (me && cur !== me) return;
        const next = yield* Ref.updateAndGet(status, (c) => ({ ...c, ...patch, ts: Date.now() }));
        yield* bus.event(next);
        yield* bus.log({ actor: "system", kind: next.state, detail: `@${next.username}${next.title ? ` · ${next.title}` : ""}${next.detail ? ` · ${next.detail}` : ""}`, ok: next.state !== "error" });
      });

    // ---------------- recording (archive) ----------------
    const finalize = (me: Current, file: string) =>
      Effect.gen(function* () {
        me.finalizing++;
        yield* bus.setHealth({ recorder: "finalizing" });
        yield* publishRecording;
        const t0 = Date.now();
        const r = yield* finalizeMp4(file).pipe(Effect.catchAll((e) => Effect.succeed({ ok: false as const, error: e.message })));
        me.finalizing--;
        yield* bus.setHealth({ recorder: me.rec ? "running" : "off" });
        yield* publishRecording;
        if (r.ok) yield* bus.log({ actor: "system", kind: "record", detail: `finalized ${path.basename(file)} (seekable mp4)`, ok: true, latencyMs: Date.now() - t0 });
        else yield* bus.log({ actor: "system", kind: "record", detail: `finalize failed for ${path.basename(file)} (${r.error}); fragmented file kept`, ok: false });
      }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`finalize: ${c.toString().slice(0, 200)}`)));

    const startRecordingFor = (me: Current) =>
      Effect.gen(function* () {
        const input = me.flvUrl;
        if (!input) return { ok: false as const, error: "no live video to record" };
        if (me.rec) return { ok: false as const, error: "already recording" };
        const n = me.meta.videos.length + 1;
        const file = n === 1 ? `${me.base}.mp4` : `${me.base}.rec${n}.mp4`;
        const proc = yield* runRecorder(input, file, { localFile: me.mode === "simulate" }).pipe(Effect.catchAll((e) => Effect.succeed(null as Bun.Subprocess | null).pipe(Effect.tap(() => bus.log({ actor: "system", kind: "record", detail: e.message, ok: false })))));
        if (!proc) return { ok: false as const, error: "could not start ffmpeg" };
        const startTs = Date.now();
        me.rec = { proc, file, startTs };
        me.meta.videos.push({ file: path.basename(file), startTs, endTs: null });
        yield* writeMeta(me.base, me.meta);
        yield* bus.setHealth({ recorder: "running" });
        yield* bus.log({ actor: "system", kind: "record", detail: `recording started → ${path.basename(file)}`, ok: true });
        yield* publishRecording;
        // If the recorder dies on its own (network), close the segment honestly.
        yield* Effect.promise(() => proc.exited).pipe(
          Effect.flatMap((code) => Effect.gen(function* () {
            if (me.rec?.proc !== proc) return; // stopped on purpose
            yield* bus.log({ actor: "system", kind: "record", detail: `recorder exited (code ${code}); segment closed`, ok: false });
            yield* stopRecordingFor(me, `recorder exited (${code})`, false);
          })),
          Effect.forkIn(me.scope),
        );
        return { ok: true as const, file };
      });

    /** Stop the current segment: await the writer's exit, close its end time, then finalize in the background. */
    const stopRecordingFor = (me: Current, reason: string, kill = true) =>
      Effect.gen(function* () {
        if (!me.rec) return { ok: false as const, error: "not recording" };
        const rec = me.rec;
        me.rec = null;
        if (kill) yield* stopProcess(rec.proc);
        const endTs = Date.now();
        const v = me.meta.videos.find((x) => x.file === path.basename(rec.file));
        if (v) v.endTs = endTs;
        yield* writeMeta(me.base, me.meta);
        yield* bus.log({ actor: "system", kind: "record", detail: `recording stopped (${reason}) · ${Math.round((endTs - rec.startTs) / 1000)} s`, ok: true });
        yield* publishRecording;
        yield* Effect.forkDaemon(finalize(me, rec.file));
        return { ok: true as const, file: rec.file };
      });

    // ---------------- ending ----------------
    const summarize = (me: Current, reason: string) =>
      Effect.gen(function* () {
        const stats = me.stats ? yield* me.stats : null;
        const totals = yield* bus.totals;
        const set = yield* store.current;
        const events = me.recorder ? yield* me.recorder.events : me.replayEvents ?? [];
        const st = statsOf(events);
        const topFired = Object.entries(stats?.fired ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => ({ id, label: set.questions.find((q) => q.id === id)?.label ?? id, count }));
        const summary: SessionSummary = {
          sessionId: me.id, username: me.username, title: me.meta.title, startedAt: me.startedAt, endedAt: Date.now(), reason,
          highlights: stats?.highlights ?? 0, warnings: stats?.warnings ?? 0, spend: totals.session, peakViewers: yield* win.peakViewers,
          chatCount: st.chatCount, transcriptCount: st.transcriptCount, topFired, recording: me.mode === "replay" ? undefined : me.id,
        };
        return summary;
      });

    /** End a session. No-op unless `me` is still the current one (a late callback from an older session is ignored). */
    const endSession = (me: Current, state: "offline" | "error", reason: string, detail?: string) =>
      Effect.gen(function* () {
        const cur = yield* SynchronizedRef.get(current);
        if (cur !== me || me.stopping) return;
        me.stopping = true;
        yield* setStatus(me, { state: "offline", detail: "ending…" }).pipe(Effect.ignore);
        if (me.rec) yield* stopRecordingFor(me, reason).pipe(Effect.ignore);
        if (me.streamFiber) yield* Fiber.interrupt(me.streamFiber);
        const summary = yield* summarize(me, reason).pipe(Effect.catchAllCause(() => Effect.succeed(null)));
        if (me.recorder) {
          const events = yield* me.recorder.events;
          me.meta.stats = statsOf(events);
          me.meta.endedAt = Date.now();
          yield* writeMeta(me.base, me.meta);
          yield* me.recorder.close;
        }
        yield* SynchronizedRef.set(current, null);
        if (me.mediaScope) yield* Scope.close(me.mediaScope, Exit.void);
        yield* Scope.close(me.scope, Exit.void);
        yield* Ref.set(lastSummary, summary);
        yield* setStatus(null, { state, detail, title: undefined });
        // Wipe everything that belonged to the live session, on every client. Rules, versions, settings, highlights and the log survive.
        yield* win.reset;
        yield* bus.clearSession;
        yield* Ref.set(video, null);
        yield* Ref.set(replayInfo, null);
        yield* bus.publish({ type: "replay", replay: null });
        yield* bus.publish({ type: "video", video: null });
        yield* remove(hlsDir(), { recursive: true }).pipe(Effect.ignore);
        yield* bus.publish({ type: "reset", reason, summary });
        yield* bus.setHealth({ ffmpeg: "off", deepgram: "off", recorder: me.finalizing > 0 ? "finalizing" : "off", chatBacklog: 0 });
        yield* bus.log({ actor: "system", kind: "cleared", detail: `session data cleared: ${reason}`, ok: true });
        yield* publishRecording;
      }).pipe(Effect.catchAllCause((c) => Effect.logError(`endSession: ${c.toString().slice(0, 300)}`)));

    // ---------------- media supervision ----------------
    /** Run the media pipeline in its own child scope; restart it a bounded number of times if ffmpeg exits. */
    const superviseMedia = (me: Current, input: string, localFile: boolean): Effect.Effect<MediaHandle | null> =>
      Effect.gen(function* () {
        const mediaScope = yield* Scope.make();
        me.mediaScope = mediaScope;
        const handle = yield* runMedia(input, { localFile }).pipe(Scope.extend(mediaScope), Effect.provide(ctx), Effect.either);
        if (handle._tag === "Left") { yield* bus.log({ actor: "system", kind: "media", detail: handle.left.message, ok: false }); yield* Scope.close(mediaScope, Exit.void); me.mediaScope = null; return null; }
        // Remember the player source so a client that connects later (or reloads) gets it in `hello`.
        const st = yield* settings.get;
        yield* Ref.set(video, st.media.hls ? { kind: "hls", url: "/hls/live.m3u8", startTs: handle.right.hlsStartTs } : null);
        yield* Deferred.await(handle.right.exited).pipe(
          Effect.flatMap((code) => Effect.gen(function* () {
            if (me.stopping || (yield* SynchronizedRef.get(current)) !== me) return;
            yield* Scope.close(mediaScope, Exit.void);
            me.mediaScope = null;
            if (me.mediaRestarts < MAX_MEDIA_RESTARTS) {
              me.mediaRestarts++;
              yield* bus.log({ actor: "system", kind: "media", detail: `ffmpeg exited (code ${code}); restarting media (${me.mediaRestarts}/${MAX_MEDIA_RESTARTS})`, ok: false });
              yield* Effect.sleep(2000 * me.mediaRestarts);
              yield* superviseMedia(me, input, localFile);
            } else {
              yield* endSession(me, "error", `ffmpeg exited ${MAX_MEDIA_RESTARTS + 1} times (last code ${code})`, "media pipeline failed");
            }
          })),
          Effect.forkIn(me.scope),
        );
        return handle.right;
      });

    // ---------------- boot ----------------
    const boot = (me: Current, req: StartRequest, ready: Deferred.Deferred<void, Error>) =>
      Effect.gen(function* () {
        const st = yield* settings.get;
        yield* setStatus(me, { state: "connecting", username: me.username, detail: me.replayOf ? `replaying ${me.replayOf}` : undefined });
        let events: Stream.Stream<LiveEvent, Error>;
        if (me.mode === "simulate") {
          // Dev mode: a recording played as if it were live, through the real media pipeline (DVR, recording, search).
          const rbase = path.join(recordingsDir(), req.replayId!);
          const meta = yield* readMeta(rbase);
          const mp4 = (meta._tag === "Some" ? meta.value.videos : []).map((v) => path.join(recordingsDir(), v.file)).find((f) => Bun.file(f).size > 0) ?? `${rbase}.mp4`;
          me.meta.title = `simulated · ${meta._tag === "Some" && meta.value.title ? meta.value.title : req.replayId}`;
          me.replayEvents = yield* loadEvents(`${rbase}.jsonl`);
          if (yield* exists(mp4)) { me.flvUrl = mp4; yield* superviseMedia(me, mp4, true); }
          yield* setStatus(me, { state: "live", title: me.meta.title });
          yield* writeMeta(me.base, me.meta);
          events = replayEvents(me.replayEvents, 0);
        } else if (me.mode === "replay") {
          const rbase = path.join(recordingsDir(), me.replayOf!);
          const meta = yield* readMeta(rbase);
          me.replayEvents = yield* loadEvents(`${rbase}.jsonl`);
          if (!me.replayEvents.length) return yield* Effect.fail(new Error("recording is empty or unreadable"));
          me.meta.title = meta._tag === "Some" && meta.value.title ? `replay · ${meta.value.title}` : "replay";
          me.meta.username = meta._tag === "Some" ? meta.value.username : me.username;
          yield* setStatus(me, { state: "live", title: me.meta.title });
          events = Stream.empty;
        } else {
          const tt = yield* connectTikTok(me.username, st.tiktok.sessionId).pipe(Scope.extend(me.scope));
          events = tt.events;
          me.flvUrl = tt.flvUrl;
          me.meta.title = tt.title;
          yield* setStatus(me, { state: "live", title: tt.title });
          if (tt.flvUrl) yield* superviseMedia(me, tt.flvUrl, false);
          else yield* bus.log({ actor: "system", kind: "media", detail: "no FLV url in room info; running chat-only", ok: false });
          yield* writeMeta(me.base, me.meta);
        }
        if (me.mode !== "replay") {
          me.recorder = yield* openRecorder(`${me.base}.jsonl`).pipe(Effect.tapError((e) => bus.log({ actor: "system", kind: "record", detail: `events not recorded: ${e.message}`, ok: false })), Effect.orElseSucceed(() => null));
          if (st.media.recordVideo && me.flvUrl) yield* startRecordingFor(me);
          // Transcript / caption events are emitted by media straight to the bus: pipe them into the recorder too.
          if (me.recorder) {
            const rec = me.recorder;
            const sub = yield* bus.subscribe;
            yield* Stream.fromQueue(sub).pipe(
              Stream.filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event" && (m.event.kind === "transcript" || m.event.kind === "caption")),
              Stream.runForEach((m) => rec.record(m.event)),
              Effect.forkScoped,
            );
          }
        }
        yield* publishRecording;
        const loops = yield* runLoops({ sessionId: me.id, mode: me.mode, dryRun: me.mode === "replay" && st.replay.dryRun }).pipe(Effect.provide(ctx));
        me.stats = loops.stats;
        yield* Deferred.succeed(ready, undefined);
        if (me.mode === "replay") yield* startReplayStream(me, Math.max(0, req.offsetMs ?? 0));
        else yield* runEventStream(me, events);
      }).pipe(
        Effect.tapError((e) => Effect.gen(function* () {
          yield* Deferred.fail(ready, e instanceof Error ? e : new Error(String(e)));
          yield* endSession(me, "error", `connect failed: ${(e as Error).message ?? String(e)}`, (e as Error).message ?? String(e));
        })),
        Effect.catchAllCause(() => Effect.void),
      );

    /** Fan every source event into the window, the UI, and the recorder; tear the session down when the stream ends. */
    const runEventStream = (me: Current, events: Stream.Stream<LiveEvent, Error>) =>
      events.pipe(
        Stream.tap((e) => Effect.all([win.ingest(e), bus.event(e), me.recorder ? me.recorder.record(e) : Effect.void])),
        Stream.runDrain,
        Effect.matchEffect({
          onFailure: (e) => Effect.forkDaemon(endSession(me, "error", `stream error: ${e.message}`, e.message)),
          onSuccess: () => Effect.forkDaemon(endSession(me, "offline", me.mode === "replay" ? "replay finished" : me.mode === "simulate" ? "simulation finished" : "live ended")),
        }),
        Effect.forkScoped,
      );

    /** (Re)start the replay stream from an offset: positions the video, publishes the timeline, feeds events. */
    const startReplayStream = (me: Current, offsetMs: number) =>
      Effect.gen(function* () {
        const all = me.replayEvents!;
        const span = recordingSpan(all);
        const rbase = path.join(recordingsDir(), me.replayOf!);
        const meta = yield* readMeta(rbase);
        const segments: VideoSegment[] = [];
        for (const v of meta._tag === "Some" ? meta.value.videos : []) {
          const f = path.join(recordingsDir(), v.file);
          if (!(yield* exists(f))) continue;
          const endTs = v.endTs ?? v.startTs + (yield* probeDuration(f)) * 1000;
          segments.push({ url: `/recordings/${v.file}`, startTs: v.startTs, endTs });
        }
        const startedAt = Date.now();
        const t0 = span.first + offsetMs;
        const src: VideoSource | null = segments.length ? { kind: "file", segments, t0, startedAt } : null;
        yield* Ref.set(video, src);
        yield* bus.publish({ type: "video", video: src });
        const hist = replayBuckets(all);
        const st = yield* settings.get;
        const info: ReplayInfo = { id: me.replayOf!, username: me.meta.username, title: meta._tag === "Some" ? meta.value.title : undefined, t0: span.first, tEnd: span.last, startedAt, offsetMs, buckets: hist.buckets, bucketMs: hist.bucketMs, segments, dryRun: st.replay.dryRun };
        yield* Ref.set(replayInfo, info);
        yield* bus.publish({ type: "replay", replay: info });
        const events = replayEvents(all, offsetMs);
        const fiber = yield* events.pipe(
          Stream.tap((e) => Effect.all([win.ingest(e), bus.event(e)])),
          Stream.runDrain,
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: () => Effect.forkDaemon(endSession(me, "offline", "replay finished")).pipe(Effect.asVoid),
          }),
          Effect.forkIn(me.scope),
        );
        me.streamFiber = fiber;
      });

    // ---------------- public transitions (serialised) ----------------
    const start = (req: StartRequest) =>
      lock.withPermits(1)(Effect.gen(function* () {
        const prev = yield* SynchronizedRef.get(current);
        if (prev) yield* endSession(prev, "offline", "replaced by a new session");
        const mode: SessionMode = req.replayId ? (req.simulate ? "simulate" : "replay") : "live";
        if (mode !== "live") {
          if (!req.replayId || !isSafeId(req.replayId)) return { ok: false as const, error: "invalid recording id" };
          if (!(yield* exists(recordingPath(req.replayId, ".jsonl")))) return { ok: false as const, error: "recording not found" };
        }
        const username = (req.username ?? "").replace(/^@/, "").trim() || (mode === "live" ? (yield* settings.get).tiktok.username : mode === "simulate" ? "sim" : "replay");
        if (mode === "live" && !/^[\w.]{2,64}$/.test(username)) return { ok: false as const, error: "invalid username" };
        const id = `${username}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const scope = yield* Scope.make();
        const me: Current = {
          id, scope, username, base: path.join(recordingsDir(), id), mode, flvUrl: null, startedAt: Date.now(),
          meta: { username, startedAt: Date.now(), videos: [] }, rec: null, finalizing: 0,
          replayOf: mode === "replay" ? req.replayId : undefined, streamFiber: null, recorder: null, stats: null, mediaScope: null, mediaRestarts: 0, stopping: false,
        };
        yield* SynchronizedRef.set(current, me);
        yield* bus.beginSession(id);
        yield* gate.reset;
        const ready = yield* Deferred.make<void, Error>();
        yield* boot(me, req, ready).pipe(Scope.extend(scope), Effect.forkIn(scope));
        const r = yield* Deferred.await(ready).pipe(Effect.timeoutFail({ duration: "90 seconds", onTimeout: () => new Error("connect timed out") }), Effect.either);
        if (r._tag === "Left") { yield* endSession(me, "error", `connect failed: ${r.left.message}`, r.left.message); return { ok: false as const, error: r.left.message }; }
        return { ok: true as const, sessionId: id };
      }));

    const stop = (reason = "disconnected by user") =>
      lock.withPermits(1)(Effect.gen(function* () {
        const me = yield* SynchronizedRef.get(current);
        if (!me) return { ok: false as const, error: "no session" };
        yield* endSession(me, "offline", reason);
        return { ok: true as const };
      }));

    /** Replay seek: interrupt the event stream, reset the rolling window, restart from the offset. Highlights stay. */
    const seek = (offsetMs: number) =>
      lock.withPermits(1)(Effect.gen(function* () {
        const me = yield* SynchronizedRef.get(current);
        const info = yield* Ref.get(replayInfo);
        if (!me || me.mode !== "replay" || !info) return { ok: false as const, error: "not replaying" };
        const off = Math.max(0, Math.min(info.tEnd - info.t0, offsetMs));
        if (me.streamFiber) yield* Fiber.interrupt(me.streamFiber);
        yield* win.reset;
        yield* bus.clearRings;
        yield* bus.publish({ type: "reset", reason: "seek", summary: null });
        yield* startReplayStream(me, off);
        return { ok: true as const, offsetMs: off };
      }));

    const startRecording = lock.withPermits(1)(Effect.gen(function* () {
      const me = yield* SynchronizedRef.get(current);
      if (!me || me.mode === "replay") return { ok: false as const, error: "no live video to record" };
      return yield* startRecordingFor(me);
    }));
    const stopRecording = (reason: string) => lock.withPermits(1)(Effect.gen(function* () {
      const me = yield* SynchronizedRef.get(current);
      if (!me) return { ok: false as const, error: "not recording" };
      return yield* stopRecordingFor(me, reason);
    }));

    // ---------------- boot recovery: recordings interrupted by a crash ----------------
    yield* Effect.gen(function* () {
      const list = yield* interruptedRecordings;
      for (const { id, base, meta } of list) {
        for (const v of meta.videos) {
          if (v.endTs !== null) continue;
          const f = path.join(recordingsDir(), v.file);
          if (!(yield* exists(f))) { v.endTs = v.startTs; continue; }
          const dur = yield* probeDuration(f);
          v.endTs = v.startTs + Math.round(dur * 1000);
          const r = yield* finalizeMp4(f).pipe(Effect.catchAll((e) => Effect.succeed({ ok: false as const, error: e.message })));
          yield* bus.log({ actor: "system", kind: "record", detail: `recovered interrupted recording ${path.basename(f)} (${Math.round(dur)} s)${r.ok ? "" : `; finalize failed: ${r.error}`}`, ok: r.ok });
        }
        const ev = yield* loadEvents(`${base}.jsonl`);
        meta.stats = statsOf(ev);
        meta.endedAt = meta.endedAt ?? (meta.stats.last || Date.now());
        yield* writeMeta(base, meta);
        yield* Effect.logInfo(`recovered interrupted recording ${id}`);
      }
    }).pipe(Effect.catchAllCause((c) => Effect.logWarning(`recovery: ${c.toString().slice(0, 200)}`)), Effect.forkScoped);

    // Disk space in the health record, every 30 s.
    yield* Effect.gen(function* () {
      while (true) {
        const free = yield* diskFree(recordingsDir());
        yield* bus.setHealth({ diskFreeBytes: free });
        if (free !== null && free < 2e9) yield* bus.log({ actor: "system", kind: "disk", detail: `low disk space: ${(free / 1e9).toFixed(1)} GB free`, ok: false });
        yield* Effect.sleep(30_000);
      }
    }).pipe(Effect.forkScoped);

    // On shutdown, end the session cleanly (closes the recorder, finalizes the archive).
    yield* Effect.addFinalizer(() => Effect.gen(function* () { const me = yield* SynchronizedRef.get(current); if (me) yield* endSession(me, "offline", "server shutdown"); }));

    /** The event index of the current session: the live recorder's memory, or the replayed recording. */
    const sessionEvents = Effect.gen(function* () {
      const me = yield* SynchronizedRef.get(current);
      if (!me) return null;
      if (me.recorder) return yield* me.recorder.events;
      return me.replayEvents ?? [];
    });

    return {
      start, stop, seek, startRecording, stopRecording,
      status: Ref.get(status), video: Ref.get(video), replayInfo: Ref.get(replayInfo), summary: Ref.get(lastSummary),
      recording: Effect.map(SynchronizedRef.get(current), recordingState),
      current: Effect.map(SynchronizedRef.get(current), (s) => (s ? { id: s.id, mode: s.mode, replayOf: s.replayOf, base: s.base, videos: s.meta.videos, startedAt: s.startedAt } : null)),
      sessionEvents,
    };
  }),
}) {}
