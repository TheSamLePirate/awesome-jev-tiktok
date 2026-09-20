# tiktok:jev

Realtime decision making over a TikTok live with [TypeSafe jev](https://docs.typesafe.ai/) (System One model, via OpenRouter),
with GLM writing and rewriting the jev questions.

- **jev** answers a fixed set of typed questions (noul / choice / score) about the last 30 s of the live, every second, plus one call per chat message.
- **GLM 5.3 flash** only wakes up to turn a plain-language rule into jev questions, or to rewrite a question after you disagree with an answer or jev stays unsure.
- **GLM 4.6v** captions a video frame every few seconds so jev can reason about the picture as text.
- **Deepgram nova-3** transcribes the audio live.
- **tiktok-live-connector** delivers chat, likes, gifts, joins and viewer counts, and the FLV pull URL that ffmpeg fans out to HLS (browser), JPEG frames (vision) and PCM (Deepgram).

## Rules and media sources

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
```

Needs `ffmpeg` on PATH. Every session is recorded to `recordings/*.jsonl`; pick one in the UI (or `REPLAY=recordings/x.jsonl bun run dev:server`) to develop without a live stream.
