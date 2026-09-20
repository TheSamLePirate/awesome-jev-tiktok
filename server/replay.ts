import { Effect, Stream } from "effect";
import { appendFile, mkdir } from "node:fs/promises";
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
