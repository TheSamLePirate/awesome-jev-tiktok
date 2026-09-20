import { Effect, Ref } from "effect";
import type { ChatEvent, LiveEvent, Snapshot } from "../shared/protocol";

interface Rolling {
  chat: ChatEvent[];
  transcript: { ts: number; text: string }[];
  interim: string;
  captions: { ts: number; text: string }[];
  likes: { ts: number; count: number }[];
  gifts: { ts: number; label: string }[];
  joins: number[];
  viewers: { ts: number; count: number }[];
}

const bucket = <T extends string>(n: number, edges: [number, T][], fallback: T): T => {
  for (const [max, label] of edges) if (n <= max) return label;
  return fallback;
};

/**
 * Rolling window of everything that happened recently, and the snapshot builder.
 * Numbers are turned into named buckets here because jev is bad at arithmetic; code owns the math.
 */
export class Window extends Effect.Service<Window>()("Window", {
  effect: Effect.gen(function* () {
    const ref = yield* Ref.make<Rolling>({ chat: [], transcript: [], interim: "", captions: [], likes: [], gifts: [], joins: [], viewers: [] });

    const prune = (r: Rolling, now: number): Rolling => ({
      chat: r.chat.filter((c) => now - c.ts < 120_000).slice(-60),
      transcript: r.transcript.filter((t) => now - t.ts < 90_000),
      interim: r.interim,
      captions: r.captions.slice(-4),
      likes: r.likes.filter((l) => now - l.ts < 60_000),
      gifts: r.gifts.filter((g) => now - g.ts < 120_000),
      joins: r.joins.filter((t) => now - t < 60_000),
      viewers: r.viewers.filter((v) => now - v.ts < 180_000),
    });

    const ingest = (e: LiveEvent) =>
      Ref.update(ref, (r) => {
        switch (e.kind) {
          case "chat": return { ...r, chat: [...r.chat, e] };
          case "transcript": return e.final
            ? { ...r, interim: "", transcript: e.text.trim() ? [...r.transcript, { ts: e.ts, text: e.text.trim() }] : r.transcript }
            : { ...r, interim: e.text };
          case "caption": return { ...r, captions: [...r.captions, { ts: e.ts, text: e.text }] };
          case "like": return { ...r, likes: [...r.likes, { ts: e.ts, count: e.count }] };
          case "gift": return { ...r, gifts: [...r.gifts, { ts: e.ts, label: `${e.handle}: ${e.giftName} x${e.count}` }] };
          case "member": return { ...r, joins: [...r.joins, e.ts] };
          case "viewers": return { ...r, viewers: [...r.viewers, { ts: e.ts, count: e.count }] };
          default: return r;
        }
      });

    const snapshot = (now = Date.now()): Effect.Effect<Snapshot> =>
      Ref.modify(ref, (raw) => {
        const r = prune(raw, now);
        const chat30 = r.chat.filter((c) => now - c.ts < 30_000).length;
        const likes30 = r.likes.filter((l) => now - l.ts < 30_000).reduce((a, l) => a + l.count, 0);
        const joins30 = r.joins.filter((t) => now - t < 30_000).length;
        const vNow = r.viewers.at(-1)?.count ?? 0;
        const vThen = r.viewers.find((v) => now - v.ts < 90_000)?.count ?? vNow;
        const delta = vThen === 0 ? 0 : (vNow - vThen) / vThen;
        const transcript = [...r.transcript.filter((t) => now - t.ts < 30_000).map((t) => t.text), r.interim].filter(Boolean).join(" ");
        const snap: Snapshot = {
          ts: now,
          transcript_last_30s: transcript.slice(-1500),
          scene: r.captions.slice(-2).map((c) => c.text),
          chat_recent: r.chat.slice(-15).map((c) => ({ handle: c.handle, text: c.text.slice(0, 200), secs_ago: Math.round((now - c.ts) / 1000) })),
          activity: {
            chat_velocity: bucket(chat30, [[0, "silent"], [2, "quiet"], [8, "steady"], [25, "busy"]], "flood"),
            viewers: vNow,
            viewers_trend: delta < -0.1 ? "falling" : delta > 0.1 ? "rising" : "flat",
            likes_last_30s: bucket(likes30, [[0, "none"], [20, "few"], [150, "many"]], "burst"),
            gifts_last_60s: r.gifts.filter((g) => now - g.ts < 60_000).map((g) => g.label).slice(-5),
            new_joins_last_30s: bucket(joins30, [[0, "none"], [5, "few"]], "many"),
          },
        };
        return [snap, r];
      });

    /** Transcript lines from the last `ms` milliseconds, plus the interim line, for building a flagged excerpt. */
    const recentTranscript = (ms: number, now = Date.now()) =>
      Ref.get(ref).pipe(Effect.map((r) => {
        const lines = r.transcript.filter((t) => now - t.ts < ms).map((t) => ({ ts: t.ts, text: t.text }));
        if (r.interim.trim()) lines.push({ ts: now, text: r.interim.trim() });
        return lines;
      }));

    return { ingest, snapshot, recentTranscript };
  }),
}) {}
