import { Effect, Stream } from "effect";
import { appendFile, mkdir, readdir, stat, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { RecordingInfo, RecordingPeek, RecordingVideo } from "../shared/protocol";
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

export interface MetaVideo { file: string; startTs: number; endTs: number | null }
export interface RecordingMeta { username: string; title?: string; startedAt: number; videos: MetaVideo[] }

export const writeMeta = (base: string, meta: RecordingMeta) =>
  Effect.promise(() => writeFile(`${base}.meta.json`, JSON.stringify(meta, null, 1))).pipe(Effect.ignore);

export const readMeta = (base: string) =>
  Effect.tryPromise(() => readFile(`${base}.meta.json`, "utf8").then((t) => { const j = JSON.parse(t); /* migrate the first format */ if (!j.videos) j.videos = j.videoStartTs ? [{ file: `${path.basename(base)}.mp4`, startTs: j.videoStartTs, endTs: null }] : []; return j as RecordingMeta; })).pipe(Effect.option);

const parseEvents = (file: string) =>
  Effect.tryPromise(() => Bun.file(file).text()).pipe(
    Effect.map((text) => text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as LiveEvent; } catch { return null; } }).filter((e): e is LiveEvent => !!e)),
    Effect.orElseSucceed(() => [] as LiveEvent[]),
  );

/** First and last event timestamps of a recording, for the video offset and the duration. */
export const recordingSpan = (file: string) =>
  parseEvents(file).pipe(Effect.map((ev) => ({ first: ev[0]?.ts ?? 0, last: ev.at(-1)?.ts ?? ev[0]?.ts ?? 0 })));

const probeDuration = (file: string) =>
  Effect.tryPromise(async () => { const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdout: "pipe", stderr: "ignore" }); const out = await new Response(p.stdout).text(); await p.exited; return Number(out.trim()) || 0; }).pipe(Effect.orElseSucceed(() => 0));

const describe = (id: string) =>
  Effect.gen(function* () {
    const dir = "recordings";
    const base = path.join(dir, id);
    const events = `${base}.jsonl`;
    const st = yield* Effect.tryPromise(() => stat(events)).pipe(Effect.option);
    if (st._tag === "None") return null;
    const meta = yield* readMeta(base);
    const ev = yield* parseEvents(events);
    const first = ev[0]?.ts ?? 0, last = ev.at(-1)?.ts ?? first;
    const videos: RecordingVideo[] = [];
    for (const v of meta._tag === "Some" ? meta.value.videos : []) {
      const f = path.join(dir, v.file);
      const vs = yield* Effect.tryPromise(() => stat(f)).pipe(Effect.option);
      if (vs._tag === "None") continue;
      const dur = yield* probeDuration(f);
      videos.push({ file: v.file, startTs: v.startTs, endTs: v.endTs ?? (dur ? v.startTs + dur * 1000 : null), sizeBytes: vs.value.size, durationSec: Math.round(dur) });
    }
    const m = id.match(/^(.*)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
    const info: RecordingInfo = {
      id, events, username: meta._tag === "Some" ? meta.value.username : (m?.[1] ?? "?"), title: meta._tag === "Some" ? meta.value.title : undefined,
      createdAt: meta._tag === "Some" ? meta.value.startedAt : st.value.mtimeMs,
      durationSec: last > first ? Math.round((last - first) / 1000) : undefined,
      sizeBytes: st.value.size + videos.reduce((a, v) => a + v.sizeBytes, 0),
      eventCount: ev.length, chatCount: ev.filter((e) => e.kind === "chat").length, transcriptCount: ev.filter((e) => e.kind === "transcript").length,
      videos,
    };
    return info;
  });

export const listRecordings = Effect.gen(function* () {
  const names = yield* Effect.tryPromise(() => readdir("recordings")).pipe(Effect.orElseSucceed(() => [] as string[]));
  const out: RecordingInfo[] = [];
  for (const n of names.filter((x) => x.endsWith(".jsonl"))) { const info = yield* describe(n.replace(/\.jsonl$/, "")); if (info) out.push(info); }
  return out.sort((a, b) => b.createdAt - a.createdAt);
});

/** A quick look inside a recording: first chat lines, transcript, captions, and a per-minute activity timeline. */
export const peekRecording = (id: string) =>
  Effect.gen(function* () {
    const ev = yield* parseEvents(path.join("recordings", `${id}.jsonl`));
    const first = ev[0]?.ts ?? 0;
    const buckets = new Map<number, { chat: number; transcript: number }>();
    for (const e of ev) { const t = Math.floor((e.ts - first) / 60_000); const b = buckets.get(t) ?? { chat: 0, transcript: 0 }; if (e.kind === "chat") b.chat++; if (e.kind === "transcript" && e.final) b.transcript++; buckets.set(t, b); }
    const peek: RecordingPeek = {
      chat: ev.filter((e): e is Extract<LiveEvent, { kind: "chat" }> => e.kind === "chat").slice(0, 40).map((e) => ({ ts: e.ts, handle: e.handle, nickname: e.nickname, text: e.text })),
      transcript: ev.filter((e): e is Extract<LiveEvent, { kind: "transcript" }> => e.kind === "transcript" && e.final).slice(0, 30).map((e) => ({ ts: e.ts, text: e.text })),
      captions: ev.filter((e): e is Extract<LiveEvent, { kind: "caption" }> => e.kind === "caption").slice(0, 5).map((e) => ({ ts: e.ts, text: e.text })),
      timeline: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, b]) => ({ t, ...b })),
    };
    return peek;
  });

/** Delete a recording: events, meta, and every video listed in the meta (plus the legacy <id>.mp4). */
export const deleteRecording = (id: string) =>
  Effect.gen(function* () {
    if (!/^[\w.\-]+$/.test(id)) return false;
    const base = path.join("recordings", id);
    const meta = yield* readMeta(base);
    const files = [`${base}.jsonl`, `${base}.meta.json`, `${base}.mp4`, ...(meta._tag === "Some" ? meta.value.videos.map((v) => path.join("recordings", v.file)) : [])];
    for (const f of files) yield* Effect.promise(() => rm(f, { force: true })).pipe(Effect.ignore);
    return true;
  });
