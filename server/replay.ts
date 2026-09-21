import { Effect, Option, Ref, Schema, Stream } from "effect";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PatternTest, MomentContext, RecordingInfo, RecordingPeek, RecordingVideo, RetentionTag, SearchHit, SessionTimeline, VideoSegment } from "../shared/protocol";
import type { LiveEvent } from "../shared/protocol";
import { atomicWrite, ensureDir, exists, fileStat, FsError, readJson, readText, remove } from "./fs";
import { probeDuration } from "./media";

export const recordingsDir = () => process.env.JEV_RECORDINGS_DIR ?? "recordings";
/** Recording ids are file basenames without extension; anything else is refused before it reaches a path. */
export const isSafeId = (id: string) => /^[\w.-]{1,200}$/.test(id) && !id.includes("..");
export const recordingPath = (id: string, ext: string) => path.join(recordingsDir(), `${id}${ext}`);

// ---------------------------------------------------------------------------------------------------------------
// Recorder: one file descriptor per session, interim transcripts skipped, events kept in memory as the live index.

export interface Recorder {
  record: (e: LiveEvent) => Effect.Effect<void>;
  /** Every event recorded so far (the live index used by search / context / timeline without re-reading the file). */
  events: Effect.Effect<LiveEvent[]>;
  close: Effect.Effect<void>;
}

export const openRecorder = (file: string): Effect.Effect<Recorder, FsError> =>
  Effect.gen(function* () {
    yield* ensureDir(path.dirname(file));
    const sink = yield* Effect.try({ try: () => Bun.file(file).writer({ highWaterMark: 64 * 1024 }), catch: (cause) => new FsError({ op: "open", path: file, cause }) });
    const events = yield* Ref.make<LiveEvent[]>([]);
    const failed = yield* Ref.make(false);
    const record = (e: LiveEvent) =>
      Effect.gen(function* () {
        if (e.kind === "transcript" && !e.final) return;
        yield* Ref.update(events, (xs) => { xs.push(e); return xs; });
        const r = yield* Effect.try({ try: () => { sink.write(JSON.stringify(e) + "\n"); }, catch: (cause) => new FsError({ op: "append", path: file, cause }) }).pipe(Effect.either);
        if (r._tag === "Left") { const was = yield* Ref.getAndSet(failed, true); if (!was) yield* Effect.logError(`recorder: ${r.left.message} (further write errors for this session are not repeated)`); }
      });
    const close = Effect.tryPromise(() => Promise.resolve(sink.end())).pipe(Effect.ignore, Effect.asVoid);
    return { record, events: Ref.get(events), close };
  });

// ---------------------------------------------------------------------------------------------------------------
// Reading recordings: parsed once per (path, size, mtime) and cached.

const cache = new Map<string, { size: number; mtimeMs: number; events: LiveEvent[] }>();

const parseLines = (text: string) => text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as LiveEvent; } catch { return null; } }).filter((e): e is LiveEvent => !!e && typeof e.ts === "number");

/** Events of a recording file, cached by size and mtime. Empty when the file is missing or unreadable. */
export const loadEvents = (file: string) =>
  Effect.gen(function* () {
    const st = yield* fileStat(file).pipe(Effect.option);
    if (st._tag === "None") return [] as LiveEvent[];
    const hit = cache.get(file);
    if (hit && hit.size === st.value.size && hit.mtimeMs === st.value.mtimeMs) return hit.events;
    const events = parseLines(yield* readText(file).pipe(Effect.orElseSucceed(() => "")));
    cache.set(file, { size: st.value.size, mtimeMs: st.value.mtimeMs, events });
    if (cache.size > 12) cache.delete(cache.keys().next().value!);
    return events;
  });

/**
 * Replay recorded events at wall-clock speed from an offset. `ts` (and `endTs`, which the window prunes on) are
 * shifted by the same delta onto the current clock, evaluated AFTER the wait so two events 300 ms apart in the
 * file are 300 ms apart when they come out. The original timestamp is kept in `srcTs`.
 * `clock` is injectable so tests can run under a virtual clock.
 */
export const replayEvents = (all: LiveEvent[], offsetMs = 0, clock: () => number = Date.now): Stream.Stream<LiveEvent, never> => {
  const first = all[0]?.ts ?? clock();
  const t0 = first + offsetMs;
  const events = all.filter((e) => e.ts >= t0);
  return Stream.suspend(() => {
    const start = clock();
    return Stream.fromIterable(events).pipe(
      Stream.mapEffect((e) =>
        Effect.gen(function* () {
          const due = start + (e.ts - t0);
          const wait = due - clock();
          if (wait > 0) yield* Effect.sleep(wait);
          const now = clock();
          const delta = now - e.ts;
          const out: LiveEvent = { ...e, ts: now, srcTs: e.ts };
          if (out.kind === "transcript" && e.kind === "transcript" && e.endTs !== undefined) out.endTs = e.endTs + delta;
          return out;
        }),
      ),
    );
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Meta files

export interface MetaVideo { file: string; startTs: number; endTs: number | null }
export interface RecordingStats { eventCount: number; chatCount: number; transcriptCount: number; first: number; last: number }
export interface RecordingMeta { username: string; title?: string; startedAt: number; videos: MetaVideo[]; stats?: RecordingStats; endedAt?: number; keep?: RetentionTag; keepReason?: string }

const MetaSchema = Schema.Struct({
  username: Schema.String, title: Schema.optional(Schema.String), startedAt: Schema.Number, endedAt: Schema.optional(Schema.Number),
  videos: Schema.optionalWith(Schema.Array(Schema.Struct({ file: Schema.String, startTs: Schema.Number, endTs: Schema.NullOr(Schema.Number) })), { default: () => [] }),
  videoStartTs: Schema.optional(Schema.Number),
  stats: Schema.optional(Schema.Struct({ eventCount: Schema.Number, chatCount: Schema.Number, transcriptCount: Schema.Number, first: Schema.Number, last: Schema.Number })),
  keep: Schema.optional(Schema.Literal("keep", "ok", "expendable")), keepReason: Schema.optional(Schema.String),
});

export const writeMeta = (base: string, meta: RecordingMeta) =>
  atomicWrite(`${base}.meta.json`, JSON.stringify(meta, null, 1), 0o644).pipe(Effect.tapError((e) => Effect.logError(`meta: ${e.message}`)), Effect.ignore);

/** Video file names are basenames; a meta edited by hand cannot point outside recordings/. */
export const readMeta = (base: string): Effect.Effect<Option.Option<RecordingMeta>> =>
  readJson(`${base}.meta.json`, MetaSchema).pipe(
    Effect.map(Option.map((j): RecordingMeta => ({
      username: j.username, title: j.title, startedAt: j.startedAt, endedAt: j.endedAt, stats: j.stats,
      videos: (j.videos.length ? j.videos : j.videoStartTs ? [{ file: `${path.basename(base)}.mp4`, startTs: j.videoStartTs, endTs: null }] : []).map((v) => ({ ...v, file: path.basename(v.file) })),
    }))),
    Effect.tapError((e) => Effect.logWarning(`meta: ${e.message}`)),
    Effect.orElseSucceed(() => Option.none<RecordingMeta>()),
  );

export const statsOf = (ev: LiveEvent[]): RecordingStats => ({ eventCount: ev.length, chatCount: ev.filter((e) => e.kind === "chat").length, transcriptCount: ev.filter((e) => e.kind === "transcript" && e.final).length, first: ev[0]?.ts ?? 0, last: ev.at(-1)?.ts ?? ev[0]?.ts ?? 0 });

/** First and last event timestamps of a recording, for the video offset and the duration. */
export const recordingSpan = (ev: LiveEvent[]) => ({ first: ev[0]?.ts ?? 0, last: ev.at(-1)?.ts ?? ev[0]?.ts ?? 0 });

const describe = (id: string) =>
  Effect.gen(function* () {
    const base = path.join(recordingsDir(), id);
    const events = `${base}.jsonl`;
    const st = yield* fileStat(events).pipe(Effect.option);
    if (st._tag === "None") return null;
    const meta = yield* readMeta(base);
    // Stats come from the meta when the session wrote them; otherwise parse once (cached).
    const stats = meta._tag === "Some" && meta.value.stats ? meta.value.stats : statsOf(yield* loadEvents(events));
    const videos: RecordingVideo[] = [];
    for (const v of meta._tag === "Some" ? meta.value.videos : []) {
      const f = path.join(recordingsDir(), v.file);
      const vs = yield* fileStat(f).pipe(Effect.option);
      if (vs._tag === "None") continue;
      // ffprobe only when the meta has no end time (a recording that was never closed).
      const dur = v.endTs !== null ? (v.endTs - v.startTs) / 1000 : yield* probeDuration(f);
      videos.push({ file: v.file, startTs: v.startTs, endTs: v.endTs ?? (dur ? v.startTs + dur * 1000 : null), sizeBytes: vs.value.size, durationSec: Math.round(dur) });
    }
    const m = id.match(/^(.*)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
    const info: RecordingInfo = {
      id, events, username: meta._tag === "Some" ? meta.value.username : (m?.[1] ?? "?"), title: meta._tag === "Some" ? meta.value.title : undefined,
      createdAt: meta._tag === "Some" ? meta.value.startedAt : st.value.mtimeMs,
      durationSec: stats.last > stats.first ? Math.round((stats.last - stats.first) / 1000) : undefined,
      sizeBytes: st.value.size + videos.reduce((a, v) => a + v.sizeBytes, 0),
      eventCount: stats.eventCount, chatCount: stats.chatCount, transcriptCount: stats.transcriptCount,
      videos,
      keep: meta._tag === "Some" ? meta.value.keep : undefined, keepReason: meta._tag === "Some" ? meta.value.keepReason : undefined,
    };
    return info;
  });

export const listRecordings = Effect.gen(function* () {
  const names = yield* Effect.tryPromise(() => readdir(recordingsDir())).pipe(Effect.orElseSucceed(() => [] as string[]));
  const out: RecordingInfo[] = [];
  for (const n of names.filter((x) => x.endsWith(".jsonl"))) { const id = n.replace(/\.jsonl$/, ""); if (!isSafeId(id)) continue; const info = yield* describe(id); if (info) out.push(info); }
  return out.sort((a, b) => b.createdAt - a.createdAt);
});

/** Recordings whose meta still has an open video segment and no end: a crash or kill interrupted them. */
export const interruptedRecordings = Effect.gen(function* () {
  const names = yield* Effect.tryPromise(() => readdir(recordingsDir())).pipe(Effect.orElseSucceed(() => [] as string[]));
  const out: { id: string; base: string; meta: RecordingMeta }[] = [];
  for (const n of names.filter((x) => x.endsWith(".meta.json"))) {
    const id = n.replace(/\.meta\.json$/, "");
    if (!isSafeId(id)) continue;
    const base = path.join(recordingsDir(), id);
    const meta = yield* readMeta(base);
    if (meta._tag === "Some" && meta.value.endedAt === undefined && meta.value.videos.some((v) => v.endTs === null)) out.push({ id, base, meta: meta.value });
  }
  return out;
});

/** A quick look inside a recording: first chat lines, transcript, captions, and a per-minute activity timeline. */
export const peekRecording = (id: string) =>
  Effect.gen(function* () {
    const ev = yield* loadEvents(recordingPath(id, ".jsonl"));
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

/** Activity histogram over a set of events between `first` and `last`, `n` buckets. */
export const bucketize = (ev: LiveEvent[], first: number, last: number, n = 120) => {
  const span = Math.max(1, last - first);
  const bucketMs = Math.max(1000, Math.ceil(span / n));
  const buckets = Array.from({ length: Math.ceil(span / bucketMs) + 1 }, () => ({ chat: 0, transcript: 0 }));
  for (const e of ev) { const i = Math.min(buckets.length - 1, Math.max(0, Math.floor((e.ts - first) / bucketMs))); if (e.kind === "chat") buckets[i].chat++; else if (e.kind === "transcript" && e.final) buckets[i].transcript++; }
  return { bucketMs, buckets };
};

export const replayBuckets = (ev: LiveEvent[], n = 120) => { const { first, last } = recordingSpan(ev); return { first, last, ...bucketize(ev, first, last, n) }; };

/** Delete a recording: events, meta, and every video listed in the meta (plus the legacy <id>.mp4). */
export const deleteRecording = (id: string) =>
  Effect.gen(function* () {
    if (!isSafeId(id)) return false;
    const base = path.join(recordingsDir(), id);
    const meta = yield* readMeta(base);
    const files = [`${base}.jsonl`, `${base}.meta.json`, `${base}.mp4`, ...(meta._tag === "Some" ? meta.value.videos.map((v) => path.join(recordingsDir(), path.basename(v.file))) : [])];
    for (const f of files) yield* remove(f).pipe(Effect.ignore);
    cache.delete(`${base}.jsonl`);
    return true;
  });

/** Case-insensitive search over a session's chat and final transcript lines, newest first. */
export const searchEvents = (ev: LiveEvent[], q: string, kinds: ("chat" | "transcript")[], limit = 60): SearchHit[] => {
  const first = ev[0]?.ts ?? 0;
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const e of ev) {
    if (e.kind === "chat" && kinds.includes("chat") && (e.text.toLowerCase().includes(needle) || e.handle.toLowerCase().includes(needle) || e.nickname.toLowerCase().includes(needle))) hits.push({ ts: e.ts, offsetMs: e.ts - first, kind: "chat", text: e.text, handle: e.handle, nickname: e.nickname, avatar: e.avatar });
    else if (e.kind === "transcript" && e.final && kinds.includes("transcript") && e.text.toLowerCase().includes(needle)) hits.push({ ts: e.ts, offsetMs: e.ts - first, kind: "transcript", text: e.text });
  }
  return hits.reverse().slice(0, limit);
};

/** What was said and typed around a moment. */
/** Try a pattern on a session's chat (message scope) or final transcript lines (window scope): what would have fired. */
export const testPattern = (ev: LiveEvent[], pattern: string, flags: string, scope: "message" | "window", limit = 30): Pick<PatternTest, "total" | "matched" | "sample"> => {
  const re = new RegExp(pattern, flags.replace(/g/g, ""));
  const sample: PatternTest["sample"] = [];
  let total = 0, matched = 0;
  for (const e of ev) {
    if (e.kind !== "chat" && e.kind !== "transcript") continue;
    if (scope === "message" ? e.kind !== "chat" : e.kind !== "transcript" || !e.final) continue;
    total++;
    if (!re.test(e.text)) continue;
    matched++;
    if (sample.length < limit) sample.push(e.kind === "chat" ? { ts: e.ts, text: e.text, handle: e.handle, nickname: e.nickname, avatar: e.avatar } : { ts: e.ts, text: e.text });
  }
  return { total, matched, sample };
};

export const momentContext = (ev: LiveEvent[], ts: number, spanMs = 30_000): MomentContext => {
  const inWin = ev.filter((e) => Math.abs(e.ts - ts) <= spanMs);
  return {
    ts,
    transcript: inWin.filter((e): e is Extract<LiveEvent, { kind: "transcript" }> => e.kind === "transcript" && e.final).map((e) => ({ ts: e.ts, text: e.text })),
    chat: inWin.filter((e): e is Extract<LiveEvent, { kind: "chat" }> => e.kind === "chat").map((e) => ({ ts: e.ts, handle: e.handle, nickname: e.nickname, text: e.text, avatar: e.avatar })),
    captions: ev.filter((e): e is Extract<LiveEvent, { kind: "caption" }> => e.kind === "caption" && e.ts <= ts + 5000).slice(-1).map((e) => ({ ts: e.ts, text: e.text })),
  };
};

/** Activity buckets for a live session so far. */
export const sessionTimeline = (ev: LiveEvent[], segments: VideoSegment[], dvrStartTs: number, n = 120): SessionTimeline => {
  const first = ev[0]?.ts ?? Date.now();
  const now = Date.now();
  const { bucketMs, buckets } = bucketize(ev, first, now, n);
  return { startTs: first, endTs: now, buckets, bucketMs, segments, dvrStartTs: Math.max(first, dvrStartTs) };
};

export const recordingExists = (id: string) => (isSafeId(id) ? exists(recordingPath(id, ".jsonl")) : Effect.succeed(false));
