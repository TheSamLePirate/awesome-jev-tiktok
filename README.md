# tiktok:jev

Realtime decision making over a TikTok live with [TypeSafe jev](https://docs.typesafe.ai/) (System One model, via OpenRouter),
with GLM writing and rewriting the jev questions.

- **jev** answers a fixed set of typed questions (noul / choice / score) about the last 30 s of the live, every second, plus one call per chat message.
- **GLM 5.3 flash** only wakes up to turn a plain-language rule into jev questions, or to rewrite a question after you disagree with an answer or jev stays unsure.
- **GLM 4.6v** captions a video frame every few seconds so jev can reason about the picture as text.
- **Deepgram nova-3** transcribes the audio live.
- **tiktok-live-connector** delivers chat, likes, gifts, joins and viewer counts, and the FLV pull URL that ffmpeg fans out to HLS (browser), JPEG frames (vision) and PCM (Deepgram).

## Rules and media sources

Two kinds of rules: **jev rules** (plain language, compiled by GLM into typed questions) and **keyword / regex
rules** (evaluated in-process on every chat message or on the transcript, no model call). Rules can be paused
(the server skips them) and removed with a 60 s undo; question-set versions can be restored as a new version.
Every flag keeps its provenance (session, version, decision) and the exact state jev judged (`?` on the card).

Each rule reads a chosen set of media: **audio** (host transcript), **video** (vision captions), **chat** (messages, velocity, joins), or all three.
jev only sees the state for those sources, so unrelated media never distracts it. Questions that read different media go out as
separate parallel jev calls each tick and are merged into one decision. Rules, question versions and history persist in `runtime/store.json`.

## Director view (for the host)

`/?view=director` (button 🎬 or key `d` in the console) is a full-screen overlay for the streamer: room meters,
big prompt cards for what jev just flagged (reply to a viewer, a moderation warning, something you said, the camera),
and a three-line chat ticker. Cards expire after a configurable lifetime, click to dismiss, ★ to keep.
Add `&transparent=1&scale=1.2` to use it as an OBS browser source. `g` opens its own settings (lifetime, which
questions show, meters, ticker).

## Settings

Everything is adjustable live from the ⚙ tab (shortcut `,`): API keys (masked, testable), models, tick and caption
periods, decision thresholds, auto-refine, media extraction, GLM generation parameters, plus per-browser preferences.
`.env` provides the defaults; overrides persist in `runtime/settings.json`. Fields marked "reconnect" apply on the next
stream connection because ffmpeg and Deepgram are started once per session.

## Run

```bash
bun install
cp .env.example .env   # fill OPENROUTER_API_KEY, DEEPGRAM_API_KEY, TIKTOK_USERNAME
bun run dev            # server on :3001, UI on :5173
bun run check          # typecheck + lint + tests + build (what CI runs)
```

The server binds `127.0.0.1` by default: the console has no login and can change API keys. To reach it from another
machine set `HOST=0.0.0.0` **and** `JEV_TOKEN=<secret>`; the console and the director then take `?token=<secret>`
in their URL (media requests carry it too). `runtime/*.json` are written atomically with mode 600, and a secret equal
to its `.env` value is never written to disk.

## Safety rails for a long live

- **Budget**: `Settings → Budget` caps the session spend (default $2). Every paid call reserves an envelope first;
  at the cap, jev / vision / GLM stop, recording continues, the header shows it. A 401 / 402 from OpenRouter opens a
  circuit breaker (5 min, reset when the key is saved); a 429 pauses every loop for the `Retry-After`.
- **Back-pressure**: chat is judged through a bounded queue with an age cutoff and a per-minute budget; the rest is
  counted and logged, never billed late. An unchanged room state reuses the previous answers (no jev call).
- **Resilience**: Deepgram reconnects with backoff from a PCM queue that never blocks ffmpeg; ffmpeg is restarted
  (3×) then the session ends with an error; every source reports `available / stale / missing / error` and jev is
  told "(audio unavailable)" instead of "(silence)" when transcription is down. `/api/health` and the health bar
  under the header show all of it.
- **Recording**: the archive MP4 has its own ffmpeg, so REC start / stop are real; a stopped segment is finalized
  into a seekable file through a temp file + rename, and recordings interrupted by a crash are recovered at boot.
  The HLS DVR keeps a bounded window (`Settings → Media → DVR window`).
- **Replay**: `Settings → Replay → dry run` replays a session with zero paid calls (keyword rules still fire).

Needs `ffmpeg` on PATH. Every session is recorded to `recordings/<user>-<time>.jsonl` (events) plus, when "Record video"
is on in settings, a `.mp4` of the stream (stream copy, no re-encode) and a `.meta.json` with the start time. Pick a
recording in the header's replay picker (🎥 marks ones with video) to develop without a live stream: events are replayed
at wall-clock speed and the video is played in sync. Recordings are written as fragmented MP4 so a crash never loses
them, then remuxed into a seekable MP4 when the session ends.

If a session started without "Record video", the **REC** button on the player (key `r`) starts and stops clips on
demand; a session can hold several clips, and replay switches between them and shows "no video for this moment"
in between. During a live session the same timeline bar shows the session so far (DVR): the HLS playlist keeps every
segment, so you can search chat and host speech (⌘K), jump to a hit, watch the video from that moment with the
surrounding transcript and chat in a review strip while the live keeps recording, and press **Back to live** (`l`).
While replaying, the timeline shows the extent, the playhead with elapsed and
remaining time, chat and speech activity, video coverage, and flags as they fire; click it or use ← → to seek (the
replay restarts from that point with a clean state). The **Replays** tab lists every session with duration, chat and speech counts, clips and size; expand
one for an activity timeline, a peek at the first messages and host lines, downloads, replay, and delete.
