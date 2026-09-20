import { Data, Effect, Queue, Stream } from "effect";
import type { TranscriptEvent } from "../shared/protocol";

export class DeepgramError extends Data.TaggedError("DeepgramError")<{ message: string; code?: number; opened: boolean }> {}

/** A PCM chunk with the wall clock at which ffmpeg produced it: the media clock reference for Deepgram's offsets. */
export interface PcmChunk { ts: number; data: Uint8Array }

/**
 * Live speech-to-text over Deepgram's WebSocket. Input: 16 kHz mono s16le PCM chunks from a queue that another
 * fiber keeps draining whatever happens to this socket (so ffmpeg never blocks on a full pipe).
 * Auth uses the "token" subprotocol so this works with the plain WebSocket API in Bun.
 * Ends normally on a clean close (1000); fails with DeepgramError otherwise, so the caller decides how to reconnect.
 */
export const transcribe = (apiKey: string, audio: Queue.Dequeue<PcmChunk>, opts: { model: string; language: string; keepAlive: boolean }): Stream.Stream<TranscriptEvent, DeepgramError> =>
  Stream.asyncScoped<TranscriptEvent, DeepgramError>((emit) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({
        model: opts.model, encoding: "linear16", sample_rate: "16000", channels: "1",
        language: opts.language, interim_results: "true", smart_format: "true", endpointing: "400", utterance_end_ms: "1500",
      });
      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", apiKey]);
      // Deepgram's `start`/`duration` are seconds since the first audio byte it received on THIS socket. The first
      // chunk we send carries the wall clock at which ffmpeg produced it, so wall + start = the media clock, even
      // after a reconnect that flushes a backlog.
      let audioStartTs: number | null = null;
      let opened = false;
      const openedP = new Promise<void>((resolve, reject) => {
        ws.onopen = () => { opened = true; resolve(); };
        ws.onerror = (e) => reject(new DeepgramError({ message: `socket error: ${(e as any).message ?? "handshake failed (check the key)"}`, opened }));
      });
      ws.onmessage = (ev) => {
        try {
          const j = JSON.parse(String(ev.data));
          if (j.type === "Results") {
            const text: string = j.channel?.alternatives?.[0]?.transcript ?? "";
            if (!text) return;
            const final = Boolean(j.is_final);
            const base = audioStartTs ?? Date.now();
            const start = typeof j.start === "number" ? base + j.start * 1000 : Date.now();
            const end = typeof j.start === "number" && typeof j.duration === "number" ? base + (j.start + j.duration) * 1000 : undefined;
            void emit.single(final ? { kind: "transcript", id: crypto.randomUUID(), ts: start, endTs: end, text, final } : { kind: "transcript", ts: Date.now(), text, final });
          }
        } catch {}
      };
      ws.onclose = (e) => { if (e.code !== 1000) void emit.fail(new DeepgramError({ message: `closed: ${e.code} ${e.reason || ""}`.trim(), code: e.code, opened })); else void emit.end(); };
      yield* Effect.tryPromise({ try: () => openedP, catch: (e) => (e instanceof DeepgramError ? e : new DeepgramError({ message: String(e), opened })) });

      const keepalive = setInterval(() => { if (opts.keepAlive && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 5000);
      // Pump audio into the socket in the background, from the shared queue.
      yield* Effect.gen(function* () {
        while (true) {
          const c = yield* Queue.take(audio);
          if (ws.readyState !== WebSocket.OPEN) continue;
          if (audioStartTs === null) audioStartTs = c.ts;
          ws.send(new Uint8Array(c.data).buffer as ArrayBuffer);
        }
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => { clearInterval(keepalive); try { ws.send(JSON.stringify({ type: "CloseStream" })); ws.close(1000); } catch {} }));
    }),
  );
