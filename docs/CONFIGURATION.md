# Configuration

Three layers, from the most fixed to the most local:

1. **Environment variables** (`.env` locally, the Portainer stack in production): the process and the defaults.
2. **Runtime settings** (⚙ Settings tab, or `PATCH /api/settings`): live, shared by every client, persisted in
   `runtime/settings.json` (only the values that differ from the environment).
3. **Per-browser preferences** (`localStorage`) and **director URL parameters**: one screen only.

`POST /api/settings/reset` (Settings → reset) drops layer 2 and goes back to the environment values.

## 1. Environment variables

Read once at boot (`server/config.ts`, plus a few read directly). Bun loads `.env` from the working directory.

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | empty | Pays for jev, GLM and vision. Without it no decision is made (the app still records). Default of `keys.openrouter`. |
| `DEEPGRAM_API_KEY` | empty | Live speech-to-text. Empty = transcription off. Default of `keys.deepgram`. |
| `TIKTOK_USERNAME` | empty | Default streamer (`tiktok.username`). **When set, the server watches this account from boot** and connects when it goes live. |
| `TIKTOK_SESSION_ID` | empty | Optional TikTok `sessionid` cookie; only helps with TikTok's rate limits. Reading a live needs no login. |
| `PORT` | `3001` | HTTP port (`7777` in the Docker image). |
| `HOST` | `127.0.0.1` | Interface to bind. Loopback by default because the console can change API keys. Use `0.0.0.0` only with `JEV_TOKEN`. |
| `JEV_TOKEN` | empty | Password of the console. Empty = no auth (keep `HOST` on loopback). Set = sign-in screen, session cookie, bearer for scripts, `?token=` for OBS. |
| `JEV_REQUIRE_TOKEN` | `false` | `true`: refuse to start without `JEV_TOKEN` (set in the Docker image). |
| `TRUST_PROXY` | `false` | `true`: the client address for rate limits is the first `X-Forwarded-For` (or `X-Real-IP`). Only behind a proxy you control (Nginx Proxy Manager). |
| `REPLAY` | empty | A recording id (or `recordings/<id>.jsonl`) to replay at boot instead of watching TikTok. |
| `JEV_MODEL` | `typesafe/jev-1.13` | Default of `models.jev`. |
| `GLM_MODEL` | `z-ai/glm-5.3-flash` | Default of `models.glm`. |
| `VISION_MODEL` | `z-ai/glm-4.6v` | Default of `models.vision`. |
| `TICK_MS` | `1000` | Default of `timing.tickMs`. |
| `CAPTION_EVERY_MS` | `6000` | Default of `timing.captionEveryMs`. |
| `JEV_RUNTIME_DIR` | `./runtime` | State directory (store, settings, watcher, HLS, frames). `/data/runtime` in Docker. |
| `JEV_RECORDINGS_DIR` | `./recordings` | Recordings directory. `/data/recordings` in Docker. |

Test-only: `E2E_PORT` (3999), `E2E_LIVE` (account for the live e2e spec), `E2E_SKIP_LIVE=1`, `E2E_SKIP_BUILD=1`.

## 2. Runtime settings

Every field below is `section.key` in `PATCH /api/settings` (body `{ "section": { "key": value } }`). Values are
clamped to the given range; strings like `"on"`, `"off"`, `"0"` are accepted for booleans; a masked secret
(`••••1234`) sent back is ignored (unchanged). **R** = applies on the next stream connection (ffmpeg and Deepgram are
started once per session); everything else applies live.

### tiktok

| Key | Default | Range | Meaning |
|---|---|---|---|
| `username` **R** | `TIKTOK_USERNAME` | | The @handle used by Connect when the header field is empty, and by the watcher. |
| `sessionId` **R** | `TIKTOK_SESSION_ID` | | Optional `sessionid` cookie (secret, mode 600 on disk). |
| `autoConnect` | `false` | | Watch `username` from boot and connect as soon as it goes live. |
| `resume` | `true` | | After a live connect, keep watching: reconnect when the stream drops and after a server restart. Disconnect turns it off for that live. |
| `pollSec` | `60` | 20–600 | Seconds between two "is the account live?" checks. |

### keys

| Key | Default | Meaning |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | Applies to the next call; saving it resets the circuit breaker. Testable (`POST /api/settings/test {which:"openrouter"}`). |
| `deepgram` **R** | `DEEPGRAM_API_KEY` | Testable (`which:"deepgram"`). |

Secrets are never sent to the browser in full (`••••` + last 4 chars) and are written to disk only when they differ
from the environment.

### models

| Key | Default | Meaning |
|---|---|---|
| `jev` | `typesafe/jev-1.13` | Decision model (OpenRouter decisions API). |
| `glm` | `z-ai/glm-5.3-flash` | Prompt writer (compiles and rewrites questions). |
| `vision` | `z-ai/glm-4.6v` | Frame captioner (any OpenRouter model that accepts images). |
| `deepgram` **R** | `nova-3` | Deepgram model. |
| `language` **R** | `multi` | Speech language: `multi` (auto, can switch mid-sentence) or `fr`, `en`, `es`, `de`, `it`, `pt`, `nl`, `ja`, `ko`, `zh`. |

`POST /api/settings/test {which:"models"}` checks the three model ids (jev with a one-question ping).

### timing

| Key | Default | Range (ms) | Meaning |
|---|---|---|---|
| `tickMs` | 1000 | 250–60 000 | Period of the window questions (×3 when the room is calm). |
| `maxTickGapMs` | 15 000 | 1 000–600 000 | Ask jev again after this long even if the state did not change. |
| `captionEveryMs` | 6 000 | 1 000–600 000 | How often a frame is considered for a caption (unchanged pictures skipped; forced every 5 periods). |
| `windowMs` | 30 000 | 5 000–180 000 | How much recent transcript and chat jev sees. |
| `highlightGapMs` | 60 000 | 0–3 600 000 | Minimum time between two flags of the same window question. |
| `excerptMs` | 20 000 | 2 000–120 000 | Host speech attached to a flagged moment. |
| `toastMs` | 4 500 | 1 000–60 000 | How long a new-flag toast stays (UI). |

### decisions

| Key | Default | Range | Meaning |
|---|---|---|---|
| `fireConfidenceFloor` | 0.4 | 0–1 | Choice and score alerts fire only at or above this confidence (noul uses its own threshold). |
| `unsureBelow` | 0.35 | 0–1 | Below this, a gauge is drawn dashed and the sample is kept for auto-refine. |
| `judgeMessages` | `true` | | Run the per-message questions on every chat message. |
| `messageConcurrency` | 4 | 1–16 | Parallel per-message jev calls. |

### budget

| Key | Default | Range | Meaning |
|---|---|---|---|
| `sessionUsd` | 2 | 0–1000 | Hard cap on paid calls per session (jev, vision, GLM). 0 = no cap. Recording continues. |
| `chatPerMinute` | 120 | 1–5000 | Messages judged per minute at most; the rest only run keyword rules. |
| `chatMaxAgeMs` | 10 000 | 1 000–120 000 | A message older than this when its turn comes is skipped (never billed late). |
| `chatQueue` **R** | 200 | 10–5000 | Backlog capacity; the oldest messages are dropped beyond it. |

### replay

| Key | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Replays make no paid call; keyword rules still fire; other decisions show "not evaluated". |

### autoRefine

| Key | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `false` | | Let GLM rewrite a question jev stays unsure about (live only). Off by default: low confidence is not proof the question is wrong, and a rewrite mid-live changes what fires. |
| `emaBelow` | 0.4 | 0–1 | Confidence moving average that triggers a rewrite. |
| `minSamples` | 3 | 1–20 | Unsure states collected before asking GLM. |
| `cooldownMs` | 300 000 | 10 000–86 400 000 | Minimum time between two rewrites of the same question. |
| `intervalMs` | 20 000 | 5 000–600 000 | How often the watchdog runs. |

### media

| Key | Default | Range | Meaning |
|---|---|---|---|
| `transcription` **R** | `true` | | Send audio to Deepgram (needs a key). |
| `vision` | `true` | | Caption frames. Turning it off stops captions at once; frames are only extracted when it was on at connect. |
| `hls` **R** | `true` | | Write HLS for the browser player (needed for the DVR). |
| `dvrMinutes` **R** | 90 | 5–720 | Minutes of video kept reviewable in the player (older segments deleted; the archive is unaffected). |
| `recordVideo` **R** | `true` | | Archive the stream as MP4 from the start (otherwise REC on demand). |
| `frameWidth` **R** | 512 | 128–1920 | Frame width in pixels (smaller is cheaper to caption). |
| `frameEverySec` **R** | 2 | 0.5–60 | How often ffmpeg refreshes the frame on disk. |
| `audioKeepAlive` **R** | `true` | | Ping Deepgram during silence so it does not close the socket. |

### glm

| Key | Default | Range | Meaning |
|---|---|---|---|
| `temperature` | 0.3 | 0–2 | Lower is more literal. |
| `maxTokens` | 4000 | 256–32 000 | Ceiling for one GLM answer, reasoning included. |

### assist (jev helpers; see [ARCHITECTURE.md §3.6](ARCHITECTURE.md#36-helpers-assistts))

| Key | Default | Range | Meaning |
|---|---|---|---|
| `sessionUsd` | 0.5 | 0–100 | What the helpers may spend per session, on top of the rules. 0 = no cap. |
| `autoResolve` | `true` | | Close a "reply to" card when the host answered it. |
| `dedupe` | `true` | | Fold flags that ask the same thing into one card. |
| `thanks` | `true` | | A gift becomes a "thank X" card. |
| `thanksMinDiamonds` | 1 | 0–100 000 | Gifts below this create no card. |
| `promises` | `true` | | Host promises become cards with a due time. |
| `faq` | `true` | | Match flagged questions against `faqText`. |
| `faqText` | empty | ≤ 20 000 chars | One `question => answer` (or `question \| answer`) per line, up to 40. |
| `poll` | `true` | | Count chat messages as votes during a poll. |
| `regime` | `true` | | Attention regime (calm rooms tick 3× slower). |
| `degrade` | `true` | | Budget degradation before the cap. |
| `repair` | `true` | | Self-repair of the media pipeline. |
| `ruleHygiene` | `true` | | Keep / refine / pause / remove advice per rule. |
| `retention` | `false` | | Rank recordings at session end and delete expendable ones when disk is low. |
| `diskFloorGb` | 5 | 1–500 | Free space under which expendable recordings are deleted. |
| `interruptibility` | `true` | | The director holds chimes while the host is in full flow. |

Settings can be exported (without secrets) and imported as JSON from the Settings tab.

## 3. Per-browser preferences

Stored in `localStorage` under `jev.*`, never on the server:

- Console language (`jev.lang`: `en` / `fr`; default the browser's language).
- Alert chime (`jev.sound`), muted viewers (`jev.muted`), browser notifications (`jev.notify`).
- Director settings (`jev.director`): layout, queue order (newest / oldest), card lifetime (`ttlSec` 45), max cards (4),
  snooze minutes (3), scale, hidden questions, meters / chat / warnings / notes / clock on-off, transparent background,
  sound, celebrations, run-of-show notes.

## 4. Director URL parameters

`/?view=director` opens the host's screen. These parameters override its settings for that page only (never saved):

| Parameter | Effect |
|---|---|
| `layout=stage\|focus\|dashboard\|overlay` | Starting layout. An overlay set by the URL has no exit button (an OBS source cannot switch). |
| `transparent=1` | Transparent background (OBS browser source). |
| `scale=1.5` | Zoom factor. |
| `warnings=0` | Hide moderation warnings (what viewers may see). |
| `ticker=0` | Hide the chat ticker. |
| `meters=0` | Hide the meters. |
| `token=<JEV_TOKEN>` | Sign in without typing (exchanged for a cookie, then removed from the URL). |

Typical OBS source: `https://<host>/?view=director&layout=overlay&transparent=1&warnings=0&token=<JEV_TOKEN>`.
