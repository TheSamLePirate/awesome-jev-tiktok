import { Effect, Stream } from "effect";
import type { TranscriptEvent } from "../shared/protocol";

/**
 * Live speech-to-text over Deepgram's WebSocket. Input: 16 kHz mono s16le PCM chunks.
 * Auth uses the "token" subprotocol so this works with the plain WebSocket API in Bun.
 */
export const transcribe = (apiKey: string, audio: Stream.Stream<Uint8Array, Error>, opts: { model: string; language: string; keepAlive: boolean }): Stream.Stream<TranscriptEvent, Error> =>
  Stream.asyncScoped<TranscriptEvent, Error>((emit) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({
        model: opts.model, encoding: "linear16", sample_rate: "16000", channels: "1",
        language: opts.language, interim_results: "true", smart_format: "true", endpointing: "400", utterance_end_ms: "1500",
      });
      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", apiKey]);
      // Deepgram's `start`/`duration` are seconds since the first audio byte it received. The PCM arrives in real
      // time from the same ffmpeg that stamps the HLS segments, so first-chunk wall time + start = the media clock.
      let audioStartTs: number | null = null;
      const opened = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = (e) => reject(new Error(`deepgram: ${(e as any).message ?? "ws error"}`)); });
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
            void emit.single(final ? { kind: "transcript", ts: start, endTs: end, text, final } : { kind: "transcript", ts: Date.now(), text, final });
          }
        } catch {}
      };
      ws.onclose = (e) => { if (e.code !== 1000) void emit.fail(new Error(`deepgram closed: ${e.code} ${e.reason}`)); else void emit.end(); };
      yield* Effect.tryPromise({ try: () => opened, catch: (e) => e as Error });

      const keepalive = setInterval(() => { if (opts.keepAlive && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 5000);
      // Pump audio into the socket in the background.
      yield* audio.pipe(
        Stream.runForEach((chunk) => Effect.sync(() => { if (ws.readyState === WebSocket.OPEN) { if (audioStartTs === null) audioStartTs = Date.now(); ws.send(new Uint8Array(chunk).buffer as ArrayBuffer); } })),
        Effect.catchAll((e) => Effect.sync(() => void emit.fail(e))),
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => { clearInterval(keepalive); try { ws.send(JSON.stringify({ type: "CloseStream" })); ws.close(); } catch {} }));
    }),
  );
