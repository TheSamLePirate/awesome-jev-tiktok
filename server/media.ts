import { Data, Deferred, Duration, Effect, Queue, Ref, Stream } from "effect";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SettingsStore } from "./settings";
import { Bus } from "./bus";
import { Window } from "./window";
import { transcribe, type PcmChunk } from "./deepgram";
import { captionFrame } from "./vision";
import { ensureDir, exists, move, remove } from "./fs";

export const runtimeDir = () => process.env.JEV_RUNTIME_DIR ?? path.resolve("runtime");
export const hlsDir = () => path.join(runtimeDir(), "hls");
const framePath = () => path.join(runtimeDir(), "frames", "latest.jpg");
/** A 16x9 grayscale thumbnail written next to the frame: 144 bytes that tell whether the picture changed. */
const thumbPath = () => path.join(runtimeDir(), "frames", "thumb.raw");

export class MediaError extends Data.TaggedError("MediaError")<{ message: string }> {}

/** Deepgram streaming list price (2026), used only for the estimated line in the log; the invoice is the truth. */
const DEEPGRAM_USD_PER_MIN = { multi: 0.0092, single: 0.0077 };
const PCM_BYTES_PER_SEC = 16_000 * 2;

/** Spawn guarded: a missing ffmpeg binary is a typed failure, not a synchronous throw inside an Effect. */
const spawn = (args: string[], opts: Parameters<typeof Bun.spawn>[1]) =>
  Effect.try({ try: () => Bun.spawn(args, opts), catch: (e) => new MediaError({ message: `cannot start ${args[0]}: ${(e as Error).message}` }) });

/** SIGINT (lets ffmpeg write trailers), then SIGKILL after a grace period; resolves with the exit code. */
export const stopProcess = (proc: Bun.Subprocess, graceMs = 3000) =>
  Effect.gen(function* () {
    try { proc.kill("SIGINT"); } catch {}
    const code = yield* Effect.promise(() => Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), graceMs))]));
    if (code === null) { try { proc.kill("SIGKILL"); } catch {} return yield* Effect.promise(() => proc.exited); }
    return code;
  });

export interface MediaHandle {
  hlsStartTs: number;
  /** Resolves with ffmpeg's exit code when the main media process ends (for any reason). */
  exited: Deferred.Deferred<number>;
}

/**
 * One ffmpeg process pulls the FLV and fans it out three ways:
 *  - HLS segments on disk for the browser player (stream copy, bounded DVR window)
 *  - a JPEG (+ a tiny grayscale thumbnail) overwritten atomically every few seconds for the vision captioner
 *  - 16 kHz mono PCM on stdout for Deepgram
 * The archive MP4 is NOT written here: it has its own process (see `runRecorder`) so it can start, stop and be
 * finalized independently of the live pipeline.
 */
export const runMedia = (flvUrl: string, opts: { localFile?: boolean } = {}) =>
  Effect.gen(function* () {
    const hlsStartTs = Date.now();
    const settings = yield* SettingsStore;
    const st = yield* settings.get;
    const bus = yield* Bus;
    const win = yield* Window;

    const HLS_DIR = hlsDir(), FRAME = framePath(), THUMB = thumbPath();
    yield* remove(HLS_DIR, { recursive: true }).pipe(Effect.ignore);
    yield* ensureDir(HLS_DIR).pipe(Effect.mapError((e) => new MediaError({ message: e.message })));
    yield* ensureDir(path.dirname(FRAME)).pipe(Effect.mapError((e) => new MediaError({ message: e.message })));

    const args = [
      "ffmpeg", "-loglevel", "error", "-nostdin",
      // A local file (simulated live) is paced in real time and looped; a network stream reconnects on drops.
      ...(opts.localFile ? ["-re", "-stream_loop", "-1"] : ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]),
      "-i", flvUrl,
    ];
    // 1) HLS for the UI: a sliding window of `dvrMinutes` (2 s segments), older segments deleted. program_date_time
    //    lets the player map wall clock to a position for review. Segment names carry the run's start time: they are
    //    served as immutable, so a name reused by a later stream would replay the browser's cached video.
    if (st.media.hls) args.push("-map", "0:v", "-map", "0:a", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", String(Math.max(10, Math.round((st.media.dvrMinutes * 60) / 2))), "-hls_flags", "delete_segments+independent_segments+program_date_time", "-hls_segment_filename", path.join(HLS_DIR, `seg_${hlsStartTs.toString(36)}_%05d.ts`), path.join(HLS_DIR, "live.m3u8"));
    // 2) latest frame for vision, written atomically (temp file + rename) so a read never sees a half JPEG.
    if (st.media.vision) {
      args.push("-map", "0:v", "-vf", `fps=1/${st.media.frameEverySec},scale=${st.media.frameWidth}:-2`, "-q:v", "6", "-f", "image2", "-update", "1", "-atomic_writing", "1", "-y", FRAME);
      args.push("-map", "0:v", "-vf", `fps=1/${st.media.frameEverySec},scale=16:9`, "-f", "image2", "-c:v", "rawvideo", "-pix_fmt", "gray", "-update", "1", "-atomic_writing", "1", "-y", THUMB);
    }
    // 3) PCM for Deepgram (always on stdout so the pipe stays valid; discarded when transcription is off)
    args.push("-map", "0:a", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1");
    const proc = yield* spawn(args, { stdout: "pipe", stderr: "pipe" });
    const exited = yield* Deferred.make<number>();
    yield* bus.setHealth({ ffmpeg: "running" });
    yield* Effect.addFinalizer(() => Effect.gen(function* () { try { proc.kill(); } catch {} yield* bus.setHealth({ ffmpeg: "off" }); }));
    // Observe the exit: whoever runs the session decides whether to restart or end.
    yield* Effect.promise(() => proc.exited).pipe(
      Effect.tap((code) => Effect.all([Deferred.succeed(exited, code), bus.setHealth({ ffmpeg: "exited" })])),
      Effect.forkScoped,
    );

    // Surface ffmpeg errors in the log (rate-limited: the same line every second would flood it).
    const lastErr = yield* Ref.make({ text: "", at: 0 });
    yield* Stream.fromAsyncIterable(proc.stderr as AsyncIterable<Uint8Array>, (e) => new MediaError({ message: String(e) })).pipe(
      Stream.map((chunk) => new TextDecoder().decode(chunk).trim()),
      Stream.filter((text) => text.length > 0),
      Stream.runForEach((text) => Effect.gen(function* () {
        const prev = yield* Ref.get(lastErr);
        if (text === prev.text && Date.now() - prev.at < 30_000) return;
        yield* Ref.set(lastErr, { text, at: Date.now() });
        yield* bus.log({ actor: "system", kind: "ffmpeg", detail: text.slice(0, 200), ok: false });
      })),
      Effect.ignore,
      Effect.forkScoped,
    );

    // ---- PCM pump: ALWAYS drains stdout into a bounded sliding queue, so ffmpeg never blocks on a full pipe ----
    // 256 chunks of ~16 KB ≈ 2 min of audio; beyond that the oldest are dropped and counted.
    const pcm = yield* Queue.sliding<PcmChunk>(256);
    const dropped = yield* Ref.make(0);
    const pumped = yield* Ref.make(0);
    yield* Stream.fromAsyncIterable(proc.stdout as AsyncIterable<Uint8Array>, (e) => new MediaError({ message: String(e) })).pipe(
      Stream.runForEach((data) => Effect.gen(function* () {
        const size = Math.max(0, yield* Queue.size(pcm));
        if (size >= 256) yield* Ref.update(dropped, (n) => n + 1);
        yield* Queue.offer(pcm, { ts: Date.now(), data });
        yield* Ref.update(pumped, (n) => n + data.byteLength);
      })),
      Effect.catchAll((e) => Effect.logWarning(`pcm pump ended: ${e.message}`)),
      Effect.forkScoped,
    );

    // ---- Deepgram supervisor: consumes the queue, restarts on end or error with exponential backoff ----
    if (st.media.transcription && st.keys.deepgram) {
      const rate = st.models.language === "multi" ? DEEPGRAM_USD_PER_MIN.multi : DEEPGRAM_USD_PER_MIN.single;
      // Estimated spend: one log line per minute of audio actually sent.
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.seconds(60));
          const bytes = yield* Ref.getAndSet(pumped, 0);
          const secs = bytes / PCM_BYTES_PER_SEC;
          if (secs > 1) yield* bus.log({ actor: "deepgram", kind: "audio", detail: `${Math.round(secs)} s of audio transcribed`, ok: true, cost: (secs / 60) * rate, costKind: "estimated" });
          const d = yield* Ref.getAndSet(dropped, 0);
          if (d) yield* bus.log({ actor: "deepgram", kind: "audio", detail: `${d} PCM chunks dropped: Deepgram was not consuming fast enough`, ok: false });
        }
      }).pipe(Effect.forkScoped);

      yield* Effect.gen(function* () {
        let failures = 0, handshakeFailures = 0;
        while (true) {
          yield* bus.setHealth({ deepgram: "connecting", deepgramDetail: undefined });
          const live = yield* settings.get;
          const r = yield* transcribe(live.keys.deepgram, pcm, { model: live.models.deepgram, language: live.models.language, keepAlive: live.media.audioKeepAlive }).pipe(
            Stream.tap(() => Effect.gen(function* () { if (failures) { failures = 0; handshakeFailures = 0; yield* win.setSourceError("transcript", null); } })),
            Stream.tap(() => bus.setHealth({ deepgram: "open" })),
            Stream.runForEach((t) => Effect.all([win.ingest(t), bus.event(t)])),
            Effect.either,
          );
          if (r._tag === "Right") { yield* Effect.logInfo("deepgram: clean close, reconnecting"); yield* Effect.sleep(Duration.millis(500)); continue; }
          const e = r.left;
          if (!e.opened) handshakeFailures++;
          failures++;
          if (handshakeFailures >= 6) {
            yield* bus.setHealth({ deepgram: "gave-up", deepgramDetail: e.message });
            yield* win.setSourceError("transcript", "Deepgram unreachable or key rejected");
            yield* bus.log({ actor: "deepgram", kind: "transcribe", detail: `giving up after ${handshakeFailures} failed handshakes (${e.message}); check the Deepgram key in Settings and reconnect`, ok: false });
            return;
          }
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
          yield* bus.setHealth({ deepgram: "backoff", deepgramDetail: `${e.message} · retry in ${Math.round(delay / 1000)} s` });
          yield* win.setSourceError("transcript", `Deepgram: ${e.message}`);
          yield* bus.log({ actor: "deepgram", kind: "transcribe", detail: `${e.message}; reconnecting in ${Math.round(delay / 1000)} s`, ok: false });
          yield* Effect.sleep(Duration.millis(delay));
        }
      }).pipe(Effect.forkScoped);
    } else {
      // Nobody consumes: the queue slides, the pump keeps ffmpeg unblocked. Drop the chunks so they do not sit in memory.
      yield* Effect.gen(function* () { while (true) { yield* Queue.take(pcm); } }).pipe(Effect.forkScoped);
      yield* bus.setHealth({ deepgram: "off" });
      yield* bus.log({ actor: "system", kind: "media", detail: st.keys.deepgram ? "transcription disabled in settings" : "no Deepgram key: transcription off", ok: true });
    }

    // ---- Frame -> vision caption: only when the picture changed (or every 5 periods), with backoff on failure ----
    const lastMtime = yield* Ref.make(0);
    const lastThumb = yield* Ref.make<Uint8Array | null>(null);
    const lastCaption = yield* Ref.make<{ text: string; at: number } | undefined>(undefined);
    const visionFailures = yield* Ref.make(0);
    const captionOnce = Effect.gen(function* () {
      const live = yield* settings.get;
      if (!live.media.vision) return;
      if ((yield* bus.assist).degrade >= 1) return; // budget degradation: captions paused
      const s = yield* Effect.tryPromise({ try: () => stat(FRAME), catch: () => new MediaError({ message: "no frame yet" }) });
      const prev = yield* Ref.get(lastMtime);
      if (s.mtimeMs === prev) return;
      yield* Ref.set(lastMtime, s.mtimeMs);
      // Perceptual change gate: mean absolute difference over the 16x9 grayscale thumbnail (0..255).
      const thumb = yield* Effect.tryPromise({ try: () => readFile(THUMB), catch: () => null }).pipe(Effect.orElseSucceed(() => null));
      const before = yield* Ref.get(lastThumb);
      const last = yield* Ref.get(lastCaption);
      if (thumb && before && thumb.length === before.length) {
        let sum = 0;
        for (let i = 0; i < thumb.length; i++) sum += Math.abs(thumb[i] - before[i]);
        const mad = sum / thumb.length;
        const forced = !last || Date.now() - last.at > live.timing.captionEveryMs * 5;
        if (mad < 6 && !forced) return;
      }
      if (thumb) yield* Ref.set(lastThumb, new Uint8Array(thumb));
      const jpeg = yield* Effect.tryPromise({ try: () => readFile(FRAME), catch: (e) => new MediaError({ message: String(e) }) });
      const r = yield* captionFrame(new Uint8Array(jpeg), last?.text).pipe(
        Effect.tapError((e) => Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(visionFailures, (x) => x + 1);
          yield* bus.log({ actor: "vision", kind: "caption", detail: e.message, ok: false });
          if (n >= 3) yield* win.setSourceError("video", `vision: ${e.message}`);
        })),
      );
      yield* Ref.set(visionFailures, 0);
      yield* win.setSourceError("video", null);
      yield* Ref.set(lastCaption, { text: r.text, at: Date.now() });
      const ev = { kind: "caption" as const, ts: Date.now(), text: r.text };
      yield* Effect.all([win.ingest(ev), bus.event(ev)]);
      yield* bus.log({ actor: "vision", kind: "caption", detail: r.text.slice(0, 120), ok: true, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost: r.cost, costKind: r.costConfirmed ? "confirmed" : "unknown" });
    }).pipe(Effect.catchAllCause((c) => Effect.logDebug(`vision: ${c.toString().slice(0, 200)}`)));
    // Period is read from settings every loop so changes apply live; failures add exponential backoff.
    yield* Effect.gen(function* () {
      while (true) {
        const t0 = Date.now();
        yield* captionOnce;
        const live = yield* settings.get;
        const n = yield* Ref.get(visionFailures);
        const extra = n ? Math.min(60_000, 1000 * 2 ** Math.min(n, 6)) : 0;
        yield* Effect.sleep(Duration.millis(Math.max(200, live.timing.captionEveryMs - (Date.now() - t0)) + extra));
      }
    }).pipe(Effect.forkScoped);

    yield* bus.publish({ type: "video", video: st.media.hls ? { kind: "hls", url: "/hls/live.m3u8", startTs: hlsStartTs } : null });
    return { hlsStartTs, exited } satisfies MediaHandle;
  });

/**
 * The archive: its own ffmpeg (stream copy) writing a fragmented MP4, so it survives a hard kill and can be stopped
 * independently of the live pipeline. Returns the process; `finalizeMp4` turns the file into a seekable MP4 after it exits.
 */
export const runRecorder = (input: string, file: string, opts: { localFile?: boolean } = {}) =>
  spawn(["ffmpeg", "-loglevel", "error", "-nostdin",
    ...(opts.localFile ? ["-re", "-stream_loop", "-1"] : ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]),
    "-i", input, "-map", "0:v", "-map", "0:a", "-c", "copy", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-y", file], { stdout: "ignore", stderr: "ignore" });

/**
 * Remux a fragmented MP4 into a regular faststart MP4 so replay can seek anywhere. Stream copy: seconds, no quality
 * loss. Writes to a temp file and renames over the original only on success; the original is never truncated.
 * Must be called after the writer process has exited.
 */
export const finalizeMp4 = (file: string) =>
  Effect.gen(function* () {
    if (!(yield* exists(file))) return { ok: false as const, error: "file missing" };
    const tmp = file.replace(/\.mp4$/, ".finalizing.mp4");
    const p = yield* spawn(["ffmpeg", "-loglevel", "error", "-y", "-i", file, "-c", "copy", "-movflags", "+faststart", tmp], { stdout: "ignore", stderr: "pipe" });
    const code = yield* Effect.promise(() => p.exited);
    if (code !== 0) { yield* remove(tmp).pipe(Effect.ignore); return { ok: false as const, error: `ffmpeg exit ${code}` }; }
    const size = Bun.file(tmp).size;
    if (size < 1024) { yield* remove(tmp).pipe(Effect.ignore); return { ok: false as const, error: "remux produced an empty file" }; }
    yield* move(tmp, file).pipe(Effect.mapError((e) => new MediaError({ message: e.message })));
    return { ok: true as const };
  });

/** Duration in seconds via ffprobe, 0 when unreadable. */
export const probeDuration = (file: string) =>
  Effect.tryPromise(async () => {
    const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return Number(out.trim()) || 0;
  }).pipe(Effect.orElseSucceed(() => 0));
