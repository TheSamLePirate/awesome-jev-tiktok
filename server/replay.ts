import { Effect, Stream } from "effect";
import { appendFile, mkdir, readdir, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecordingInfo } from "../shared/protocol";
import type { LiveEvent } from "../shared/protocol";

/** Append every source event to a .jsonl file so a session can be replayed offline. */
export const recorder = (file: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => mkdir("recordings", { recursive: true }));
    return (e: LiveEvent) => Effect.promise(() => appendFile(file, JSON.stringify(e) + "\n")).pipe(Effect.ignore);
  });

/** Replay a recording at wall-clock speed, re-stamping timestamps to now. */
export const replayEvents = (file: string): Stream.Stream<LiveEvent, Error> =>
  Stream.fromEffect(Effect.tryPromise({ try: () => Bun.file(file).text(), catch: (e) => e as Error })).pipe(
    Stream.flatMap((text) => {
      const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LiveEvent);
      const t0 = events[0]?.ts ?? Date.now();
      const start = Date.now();
      return Stream.fromIterable(events).pipe(
        Stream.mapEffect((e) => {
          const due = start + (e.ts - t0);
          return Effect.sleep(Math.max(0, due - Date.now())).pipe(Effect.as({ ...e, ts: Date.now() } as LiveEvent));
        }),
      );
    }),
  );

export interface RecordingMeta { videoStartTs: number; username: string; title?: string; startedAt: number }

export const writeMeta = (base: string, meta: RecordingMeta) =>
  Effect.promise(() => writeFile(`${base}.meta.json`, JSON.stringify(meta))).pipe(Effect.ignore);

export const readMeta = (base: string) =>
  Effect.tryPromise(() => readFile(`${base}.meta.json`, "utf8").then((t) => JSON.parse(t) as RecordingMeta)).pipe(Effect.option);

/** First and last event timestamps of a recording, for the video offset and the duration. */
export const recordingSpan = (file: string) =>
  Effect.tryPromise(() => Bun.file(file).text()).pipe(
    Effect.map((text) => { const lines = text.split("\n").filter(Boolean); const first = lines[0] ? (JSON.parse(lines[0]).ts as number) : 0; const last = lines.at(-1) ? (JSON.parse(lines.at(-1)!).ts as number) : first; return { first, last }; }),
    Effect.orElseSucceed(() => ({ first: 0, last: 0 })),
  );

export const listRecordings = Effect.gen(function* () {
  const dir = "recordings";
  const names = yield* Effect.tryPromise(() => readdir(dir)).pipe(Effect.orElseSucceed(() => [] as string[]));
  const out: RecordingInfo[] = [];
  for (const n of names.filter((x) => x.endsWith(".jsonl")).sort().reverse()) {
    const base = path.join(dir, n.replace(/\.jsonl$/, ""));
    const events = `${base}.jsonl`;
    const st = yield* Effect.tryPromise(() => stat(events)).pipe(Effect.option);
    const video = yield* Effect.tryPromise(() => stat(`${base}.mp4`)).pipe(Effect.option);
    const meta = yield* readMeta(base);
    const span = yield* recordingSpan(events);
    const m = n.match(/^(.*)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.jsonl$/);
    out.push({
      id: n.replace(/\.jsonl$/, ""), events, video: video._tag === "Some" ? `${base}.mp4` : null,
      sizeBytes: (st._tag === "Some" ? st.value.size : 0) + (video._tag === "Some" ? video.value.size : 0),
      createdAt: meta._tag === "Some" ? meta.value.startedAt : (st._tag === "Some" ? st.value.mtimeMs : 0),
      username: meta._tag === "Some" ? meta.value.username : (m?.[1] ?? "?"), title: meta._tag === "Some" ? meta.value.title : undefined,
      durationSec: span.last > span.first ? Math.round((span.last - span.first) / 1000) : undefined,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
});
