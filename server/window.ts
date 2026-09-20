import { Effect, Ref } from "effect";
import type { ChatEvent, LiveEvent, Snapshot, Source, SourceHealth } from "../shared/protocol";

interface Rolling {
  chat: ChatEvent[];
  transcript: { ts: number; text: string }[];
  interim: { ts: number; text: string } | null;
  captions: { ts: number; text: string }[];
  likes: { ts: number; count: number }[];
  gifts: { ts: number; label: string }[];
  joins: number[];
  viewers: { ts: number; count: number }[];
  /** last time each source produced anything (interim speech counts for transcript); -1 = never this session */
  lastSeen: Record<Source, number>;
  errors: Record<Source, string | null>;
}

/** A caption older than this is not "the scene" any more. An interim line older than this is a dead partial. */
const CAPTION_MAX_AGE_MS = 90_000;
const INTERIM_MAX_AGE_MS = 8_000;
/** A source that produced nothing for longer than this is reported "stale" (2× the default window). */
const STALE_AFTER_MS = 60_000;

const bucket = <T extends string>(n: number, edges: [number, T][], fallback: T): T => {
  for (const [max, label] of edges) if (n <= max) return label;
  return fallback;
};

const empty = (): Rolling => ({ chat: [], transcript: [], interim: null, captions: [], likes: [], gifts: [], joins: [], viewers: [], lastSeen: { transcript: -1, video: -1, chat: -1 }, errors: { transcript: null, video: null, chat: null } });

/**
 * Rolling window of everything that happened recently, and the snapshot builder.
 * Numbers are turned into named buckets here because jev is bad at arithmetic; code owns the math.
 * Every source also reports its freshness so a decision can tell "silence" from "audio unavailable".
 */
export class Window extends Effect.Service<Window>()("Window", {
  effect: Effect.gen(function* () {
    const ref = yield* Ref.make<Rolling>(empty());

    const prune = (r: Rolling, now: number): Rolling => ({
      chat: r.chat.filter((c) => now - c.ts < 120_000).slice(-60),
      transcript: r.transcript.filter((t) => now - t.ts < 90_000),
      interim: r.interim && now - r.interim.ts < INTERIM_MAX_AGE_MS ? r.interim : null,
      captions: r.captions.filter((c) => now - c.ts < CAPTION_MAX_AGE_MS).slice(-4),
      likes: r.likes.filter((l) => now - l.ts < 60_000),
      gifts: r.gifts.filter((g) => now - g.ts < 120_000),
      joins: r.joins.filter((t) => now - t < 60_000),
      viewers: r.viewers.filter((v) => now - v.ts < 180_000),
      lastSeen: r.lastSeen,
      errors: r.errors,
    });

    const seen = (r: Rolling, s: Source, ts: number): Rolling => ({ ...r, lastSeen: { ...r.lastSeen, [s]: Math.max(r.lastSeen[s], ts) }, errors: r.errors[s] ? { ...r.errors, [s]: null } : r.errors });

    const ingest = (e: LiveEvent) =>
      Ref.update(ref, (r) => {
        switch (e.kind) {
          case "chat": return seen({ ...r, chat: [...r.chat, e] }, "chat", e.ts);
          case "transcript": return seen(e.final
            ? { ...r, interim: null, transcript: e.text.trim() ? [...r.transcript, { ts: e.endTs ?? e.ts, text: e.text.trim() }] : r.transcript }
            : { ...r, interim: { ts: e.ts, text: e.text } }, "transcript", e.endTs ?? e.ts);
          case "caption": return seen({ ...r, captions: [...r.captions, { ts: e.ts, text: e.text }] }, "video", e.ts);
          case "like": return seen({ ...r, likes: [...r.likes, { ts: e.ts, count: e.count }] }, "chat", e.ts);
          case "gift": return seen({ ...r, gifts: [...r.gifts, { ts: e.ts, label: `${e.handle}: ${e.giftName} x${e.count}` }] }, "chat", e.ts);
          case "member": return seen({ ...r, joins: [...r.joins, e.ts] }, "chat", e.ts);
          case "viewers": return seen({ ...r, viewers: [...r.viewers, { ts: e.ts, count: e.count }] }, "chat", e.ts);
          default: return r;
        }
      });

    const healthOf = (r: Rolling, s: Source, now: number): SourceHealth => {
      if (r.errors[s]) return { state: "error", ageMs: r.lastSeen[s] < 0 ? -1 : now - r.lastSeen[s], error: r.errors[s]! };
      if (r.lastSeen[s] < 0) return { state: "missing", ageMs: -1 };
      const age = now - r.lastSeen[s];
      return { state: age > STALE_AFTER_MS ? "stale" : "available", ageMs: age };
    };

    const snapshot = (now = Date.now(), windowMs = 30_000): Effect.Effect<Snapshot> =>
      Ref.modify(ref, (raw) => {
        const r = prune(raw, now);
        const chat30 = r.chat.filter((c) => now - c.ts < 30_000).length;
        const likes30 = r.likes.filter((l) => now - l.ts < 30_000).reduce((a, l) => a + l.count, 0);
        const joins30 = r.joins.filter((t) => now - t < 30_000).length;
        const vNow = r.viewers.at(-1)?.count ?? 0;
        const vThen = r.viewers.find((v) => now - v.ts < 90_000)?.count ?? vNow;
        const delta = vThen === 0 ? 0 : (vNow - vThen) / vThen;
        const transcript = [...r.transcript.filter((t) => now - t.ts < windowMs).map((t) => t.text), r.interim?.text ?? ""].filter(Boolean).join(" ");
        const snap: Snapshot = {
          ts: now,
          transcript_last_30s: transcript.slice(-1500),
          scene: r.captions.slice(-2).map((c) => c.text),
          chat_recent: r.chat.filter((c) => now - c.ts < Math.max(windowMs, 60_000)).slice(-15).map((c) => ({ handle: c.handle, text: c.text.slice(0, 200), secs_ago: Math.round((now - c.ts) / 1000) })),
          activity: {
            chat_velocity: bucket(chat30, [[0, "silent"], [2, "quiet"], [8, "steady"], [25, "busy"]], "flood"),
            viewers: vNow,
            viewers_trend: delta < -0.1 ? "falling" : delta > 0.1 ? "rising" : "flat",
            likes_last_30s: bucket(likes30, [[0, "none"], [20, "few"], [150, "many"]], "burst"),
            gifts_last_60s: r.gifts.filter((g) => now - g.ts < 60_000).map((g) => g.label).slice(-5),
            new_joins_last_30s: bucket(joins30, [[0, "none"], [5, "few"]], "many"),
          },
          sources: { transcript: healthOf(r, "transcript", now), video: healthOf(r, "video", now), chat: healthOf(r, "chat", now) },
        };
        return [snap, r];
      });

    /** Transcript lines from the last `ms` milliseconds, plus the interim line, for building a flagged excerpt. */
    const recentTranscript = (ms: number, now = Date.now()) =>
      Ref.get(ref).pipe(Effect.map((r) => {
        const lines = r.transcript.filter((t) => now - t.ts < ms).map((t) => ({ ts: t.ts, text: t.text }));
        if (r.interim && now - r.interim.ts < INTERIM_MAX_AGE_MS && r.interim.text.trim()) lines.push({ ts: r.interim.ts, text: r.interim.text.trim() });
        return lines;
      }));

    /** Peak viewers seen so far (for the session summary). */
    const peakViewers = Ref.get(ref).pipe(Effect.map((r) => r.viewers.reduce((a, v) => Math.max(a, v.count), 0)));

    /** Media reports a source failure (Deepgram down, vision failing); cleared by the next successful event. */
    const setSourceError = (s: Source, error: string | null) => Ref.update(ref, (r) => ({ ...r, errors: { ...r.errors, [s]: error } }));

    const reset = Ref.set(ref, empty());

    return { ingest, snapshot, recentTranscript, reset, setSourceError, peakViewers };
  }),
}) {}
