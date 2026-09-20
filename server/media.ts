import { Effect, Stream, Schedule, Ref, Duration } from "effect";
import { mkdir, readFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { AppConfig } from "./config";
import { Bus } from "./bus";
import { Window } from "./window";
import { transcribe } from "./deepgram";
import { captionFrame } from "./vision";

export const RUNTIME_DIR = path.resolve("runtime");
export const HLS_DIR = path.join(RUNTIME_DIR, "hls");
const FRAME = path.join(RUNTIME_DIR, "frames", "latest.jpg");

/**
 * One ffmpeg process pulls the FLV and fans it out three ways:
 *  - HLS segments on disk for the browser player (stream copy, no re-encode)
 *  - a JPEG that is overwritten every few seconds for the vision captioner
 *  - 16 kHz mono PCM on stdout for Deepgram
 */
export const runMedia = (flvUrl: string) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const bus = yield* Bus;
    const win = yield* Window;

    yield* Effect.promise(async () => {
      await rm(HLS_DIR, { recursive: true, force: true });
      await mkdir(HLS_DIR, { recursive: true });
      await mkdir(path.dirname(FRAME), { recursive: true });
    });

    const proc = Bun.spawn([
      "ffmpeg", "-loglevel", "error", "-nostdin",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-i", flvUrl,
      // 1) HLS for the UI
      "-map", "0:v", "-map", "0:a", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "10",
      "-hls_flags", "delete_segments+independent_segments", "-hls_segment_filename", path.join(HLS_DIR, "seg_%05d.ts"), path.join(HLS_DIR, "live.m3u8"),
      // 2) latest frame for vision
      "-map", "0:v", "-vf", "fps=1/2,scale=512:-2", "-q:v", "6", "-f", "image2", "-update", "1", "-y", FRAME,
      // 3) PCM for Deepgram
      "-map", "0:a", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
    ], { stdout: "pipe", stderr: "pipe" });

    yield* Effect.addFinalizer(() => Effect.sync(() => { try { proc.kill(); } catch {} }));

    // Surface ffmpeg errors in the log.
    yield* Effect.promise(async () => { for await (const chunk of proc.stderr) console.error("[ffmpeg]", new TextDecoder().decode(chunk).trim()); }).pipe(Effect.forkScoped);

    const audio = Stream.fromAsyncIterable(proc.stdout as AsyncIterable<Uint8Array>, (e) => new Error(String(e)));

    // Audio -> Deepgram -> bus + window. Reconnect Deepgram if it drops.
    yield* transcribe(cfg.deepgramKey, audio).pipe(
      Stream.runForEach((t) => Effect.all([win.ingest(t), bus.event(t)])),
      Effect.tapError((e) => Effect.logWarning(`deepgram: ${e.message}`)),
      Effect.retry(Schedule.spaced("2 seconds")),
      Effect.forkScoped,
    );

    // Frame -> vision caption every N seconds, only when the file actually changed.
    const lastMtime = yield* Ref.make(0);
    const lastCaption = yield* Ref.make<string | undefined>(undefined);
    yield* Effect.gen(function* () {
      const s = yield* Effect.tryPromise({ try: () => stat(FRAME), catch: () => new Error("no frame yet") });
      const prev = yield* Ref.get(lastMtime);
      if (s.mtimeMs === prev) return;
      yield* Ref.set(lastMtime, s.mtimeMs);
      const jpeg = yield* Effect.tryPromise({ try: () => readFile(FRAME), catch: (e) => e as Error });
      const previous = yield* Ref.get(lastCaption);
      const text = yield* captionFrame(new Uint8Array(jpeg), previous);
      yield* Ref.set(lastCaption, text);
      const ev = { kind: "caption" as const, ts: Date.now(), text };
      yield* Effect.all([win.ingest(ev), bus.event(ev)]);
    }).pipe(
      Effect.catchAll((e) => Effect.logDebug(`vision: ${String((e as any).message ?? e)}`)),
      Effect.repeat(Schedule.spaced(Duration.millis(cfg.captionEveryMs))),
      Effect.forkScoped,
    );

    yield* bus.publish({ type: "hls", url: "/hls/live.m3u8" });
  });
