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
rules** (evaluated in-process on every chat message or on the transcript, no model call). Rules can be **edited in
place** (✎: text, sources, and for keyword rules the pattern and label; a jev rule is recompiled by GLM, a keyword
rule keeps its question id so its flags stay attached), paused (the server skips them) and removed with a 60 s undo;
question-set versions can be restored as a new version. A keyword pattern can be **tested before it is added** (▶ Test
on): the server runs it on the current session or any recording and shows how many messages match, with a sample.
Every flag keeps its provenance (session, version, decision) and the exact state jev judged (`?` on the card).

## Staying connected

The header's 👁 button (or `Settings → TikTok → Auto-connect`) makes the server **watch an account**: it checks every
minute whether the account is live and connects on its own. After any live connect the watcher stays on (`Resume`), so
a dropped stream is reconnected within seconds and a server restart picks the live back up; **Disconnect** turns it off
for that live. The header pill shows who it waits for and when it looks next; the director's empty stage says the same.

Each rule reads a chosen set of media: **audio** (host transcript), **video** (vision captions), **chat** (messages, velocity, joins), or all three.
jev only sees the state for those sources, so unrelated media never distracts it. Questions that read different media go out as
separate parallel jev calls each tick and are merged into one decision. Rules, question versions and history persist in `runtime/store.json`.

## Director view (for the host)

`/?view=director` (button 🎬 or key `d` in the console) is the host's second screen: a tablet beside the camera,
a monitor, or an OBS browser source. Four layouts, keys `1`–`4`:

- **Stage**: room meters with trend sparklines, then the prompt queue (reply to a viewer, a moderation warning,
  something you said, the camera). `↓`/`↑` select, `↵` done, `f` feature, `z` snooze for a few minutes.
- **Focus**: one prompt at teleprompter size, the rest of the queue as "up next".
- **Dashboard**: viewers with trend and peak, chat pace, likes, diamonds and top gifters, new follows, on-air clock,
  then **every rule of the active set**: room rules with their current answer, trend and "fired ×N · when"; chat rules
  with "matched / judged", the last message they flagged (with its avatar), and paused / keyword / muted tags. Below,
  the queue and the gift / follow / join feed (avatars from the stream, or from the viewer's chat for older recordings).
- **Overlay**: for OBS, only what viewers may see: the featured prompt as a lower third and the chat ticker.
  Add `&layout=overlay&transparent=1&warnings=0` to the browser-source URL; URL options never save. On a screen
  a person is looking at, the **✕ Exit overlay** button (or `esc`) goes back to the stage; an overlay set by the URL
  has no exit, since an OBS source cannot switch layout.

Also: a countdown (`t`, e.g. `5`, `2:30`, `45s`, chimes at zero), a run of show with checkboxes (`n`, written in
the settings), gift and follow celebrations, a chime on new prompts (`s`), keep-awake (`w`), full screen (`⇧F`),
and a recap of the session once the stream ends. `g` opens the settings (layout, queue order, lifetime, snooze,
scale, which questions show); `?` lists the keys.

## Language

The console and the director speak English and French: `Settings → Browser → Language` (or the director's settings),
remembered per browser, with the browser's language as the default. GLM writes each question's on-screen label in the
language of the rule you typed; the server's own log lines stay in English.

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

### Tests

```bash
bun run test           # server tests, then the web unit tests (bun test + happy-dom + testing-library)
bun run test:web:cov   # web unit tests with coverage; bunfig.toml requires 100 % of lines
bun run e2e            # Playwright: real server on :3999 (isolated runtime, synthetic replay) + a live TikTok stream
E2E_LIVE=someone bun run e2e:live   # the live spec against another account (default @equinoxerpfr)
E2E_SKIP_LIVE=1 bun run e2e         # everything except the live stream
```

The e2e server builds `dist/`, runs from `e2e/.tmp` (never your `runtime/` or `recordings/`) and caps the live
session's spend at $0.50. The live spec skips itself when the account is not streaming.

The server binds `127.0.0.1` by default: the console can change API keys, so it must not be reachable by strangers.
To use it from a tablet or another PC on the network set `HOST=0.0.0.0` **and** `JEV_TOKEN=<secret>`. The console
then shows a **sign-in screen**: the token is posted once and exchanged for an HttpOnly, SameSite=Strict session
cookie (30 days, derived from the token, never the token itself), so nothing secret stays in the page, its URL or its
storage; media requests ride on the same cookie. A link with `?token=<secret>` signs in too and the token is removed
from the address bar at once; keep that form for OBS browser sources, which cannot type. **Sign out** is in the
settings. Scripts use `Authorization: Bearer <secret>`. Failed sign-ins are throttled per address (10 per 15 min),
the API has a per-address budget (600 requests / min), and a cookie-authenticated write from another origin is refused.
`runtime/*.json` are written atomically with mode 600, and a secret equal to its `.env` value is never written to disk.

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
