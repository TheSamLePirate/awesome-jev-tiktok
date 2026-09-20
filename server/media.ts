import { Effect, Stream, Schedule, Ref, Duration } from "effect";
import { mkdir, readFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { SettingsStore } from "./settings";
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
export const runMedia = (flvUrl: string, videoFile: string | null) =>
  Effect.gen(function* () {
    const settings = yield* SettingsStore;
    const st = yield* settings.get;
    const bus = yield* Bus;
    const win = yield* Window;

    yield* Effect.promise(async () => {
      await rm(HLS_DIR, { recursive: true, force: true });
      await mkdir(HLS_DIR, { recursive: true });
      await mkdir(path.dirname(FRAME), { recursive: true });
    });

    const args = [
      "ffmpeg", "-loglevel", "error", "-nostdin",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-i", flvUrl,
    ];
    // 1) HLS for the UI
    if (st.media.hls) args.push("-map", "0:v", "-map", "0:a", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "10", "-hls_flags", "delete_segments+independent_segments", "-hls_segment_filename", path.join(HLS_DIR, "seg_%05d.ts"), path.join(HLS_DIR, "live.m3u8"));
    // 1b) fragmented MP4 recording: playable even if ffmpeg is killed mid-way (no trailing moov needed)
    if (videoFile) args.push("-map", "0:v", "-map", "0:a", "-c", "copy", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-y", videoFile);
    // 2) latest frame for vision
    if (st.media.vision) args.push("-map", "0:v", "-vf", `fps=1/${st.media.frameEverySec},scale=${st.media.frameWidth}:-2`, "-q:v", "6", "-f", "image2", "-update", "1", "-y", FRAME);
    // 3) PCM for Deepgram (always on stdout so the pipe stays valid; discarded when transcription is off)
    args.push("-map", "0:a", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1");
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

    yield* Effect.addFinalizer(() => Effect.sync(() => { try { proc.kill(); } catch {} }));

    // Surface ffmpeg errors in the log.
    yield* Effect.promise(async () => { for await (const chunk of proc.stderr) console.error("[ffmpeg]", new TextDecoder().decode(chunk).trim()); }).pipe(Effect.forkScoped);

    const audio = Stream.fromAsyncIterable(proc.stdout as AsyncIterable<Uint8Array>, (e) => new Error(String(e)));

    // Audio -> Deepgram -> bus + window. Reconnect Deepgram if it drops.
    if (st.media.transcription && st.keys.deepgram) {
      yield* transcribe(st.keys.deepgram, audio, { model: st.models.deepgram, language: st.models.language, keepAlive: st.media.audioKeepAlive }).pipe(
        Stream.runForEach((t) => Effect.all([win.ingest(t), bus.event(t)])),
        Effect.tapError((e) => Effect.logWarning(`deepgram: ${e.message}`)),
        Effect.retry(Schedule.spaced("2 seconds")),
        Effect.forkScoped,
      );
    } else {
      yield* audio.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      yield* bus.log({ actor: "system", kind: "media", detail: st.keys.deepgram ? "transcription disabled in settings" : "no Deepgram key: transcription off", ok: true });
    }

    // Frame -> vision caption every N seconds, only when the file actually changed.
    const lastMtime = yield* Ref.make(0);
    const lastCaption = yield* Ref.make<string | undefined>(undefined);
    const captionOnce = Effect.gen(function* () {
      const live = yield* settings.get;
      if (!live.media.vision) return;
      const s = yield* Effect.tryPromise({ try: () => stat(FRAME), catch: () => new Error("no frame yet") });
      const prev = yield* Ref.get(lastMtime);
      if (s.mtimeMs === prev) return;
      yield* Ref.set(lastMtime, s.mtimeMs);
      const jpeg = yield* Effect.tryPromise({ try: () => readFile(FRAME), catch: (e) => e as Error });
      const previous = yield* Ref.get(lastCaption);
      const r = yield* captionFrame(new Uint8Array(jpeg), previous).pipe(
        Effect.tapError((e) => e._tag === "VisionError" ? bus.log({ actor: "vision", kind: "caption", detail: e.message, ok: false }) : Effect.void),
      );
      yield* Ref.set(lastCaption, r.text);
      const ev = { kind: "caption" as const, ts: Date.now(), text: r.text };
      yield* Effect.all([win.ingest(ev), bus.event(ev)]);
      yield* bus.log({ actor: "vision", kind: "caption", detail: r.text.slice(0, 120), ok: true, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost: r.cost });
    }).pipe(Effect.catchAll((e) => Effect.logDebug(`vision: ${String((e as any).message ?? e)}`)));
    // Period is read from settings every loop so changes apply live.
    yield* Effect.gen(function* () {
      while (true) {
        const t0 = Date.now();
        yield* captionOnce;
        const live = yield* settings.get;
        yield* Effect.sleep(Duration.millis(Math.max(200, live.timing.captionEveryMs - (Date.now() - t0))));
      }
    }).pipe(Effect.forkScoped);

    yield* bus.publish({ type: "video", video: st.media.hls ? { kind: "hls", url: "/hls/live.m3u8" } : null });
    if (videoFile) yield* bus.log({ actor: "system", kind: "record", detail: `recording video to ${videoFile}`, ok: true });
  });
