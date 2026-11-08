# Architecture

How tiktok:jev works inside, from the TikTok socket to a card on the host's screen. Read this before you change the
server. Paths are relative to the repository root.

## 1. The big picture

```
                         ┌────────────────────────── Bun server (server/) ──────────────────────────┐
 TikTok live ──socket──► │ tiktok.ts ─ chat, gifts, likes, joins, follows, viewers ─┐               │
            └─FLV pull─► │ media.ts: one ffmpeg ─┬─ HLS segments ──────────────────┼──► /hls/*      │
                         │                       ├─ JPEG every N s ─► vision.ts ───┤  (captions)   │
                         │                       └─ 16 kHz PCM ─► deepgram.ts ─────┤  (transcript) │
                         │ media.ts: 2nd ffmpeg ─► archive MP4 ─────────────────────┼──► /recordings│
                         │                                                          ▼               │
                         │                           window.ts (rolling 30 s state) ──► Snapshot    │
                         │                                                          │               │
                         │  loop.ts ── every tick: window questions ─► jev.ts ──────┤               │
                         │          └─ every chat message: message questions ─► jev │               │
                         │  assist.ts ─ built-in helpers (dedupe, thanks, polls…) ─► jev            │
                         │  glm.ts ─── rule text ⇄ jev questions (only on edits / feedback)         │
                         │  gate.ts ── budget, 429 back-off, 401/402 breaker (every paid call)      │
                         │  store.ts ─ rules, question versions, highlights → runtime/store.json    │
                         │  bus.ts ─── pub/sub + ring buffers + cost totals + health ─► /ws         │
                         └───────────────────────────────────────────────────────────────────────────┘
                                                             │ WebSocket (hello + deltas) + REST /api
                                    ┌────────────────────────┴────────────────────────┐
                                    ▼                                                 ▼
                         Console  (web/App.tsx)                         Director (web/Director.tsx)
                         operator: rules, flags, replays, settings      host: prompts, meters, overlay
```

All paid model calls go through OpenRouter (jev, GLM, vision), except speech-to-text (Deepgram). Nothing calls into
the browser: it talks to the server only, so API keys never leave the server.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **jev** | TypeSafe's "System One" decision model (`typesafe/jev-1.13` on OpenRouter, `POST /api/alpha/decisions`). It does not write text: it receives a JSON **state** and a map of typed **questions**, and returns calibrated answers. Cheap (~$0.00003 per call) and fast. |
| **Question** (`WatchQuestion`) | One thing jev answers. Type `noul` (yes/no probability), `choice` (one option among named criteria, with a confidence) or `score` (ordered levels, float index). Carries a label, a `scope`, `sources` and an `alert` condition. |
| **Rule** (`Rule`) | What the operator types ("tell me when someone asks about the price"). A **jev rule** is compiled by GLM into 1–5 questions. A **keyword rule** is a regex evaluated in-process (free, no model call). A rule can be paused. |
| **Question set** (`QuestionSet`) | The versioned list of all questions. Every change (add, edit, refine, restore) makes a new version; the last 60 are kept and can be diffed and restored. |
| **Scope** | `window`: judged on every tick on the last ~30 s of the room. `message`: judged once per incoming chat message. |
| **Sources** | Which media a question reads: `transcript` (host speech), `video` (vision captions), `chat` (messages, velocity, joins). jev only sees the state of those sources; questions with different sources become separate parallel calls. |
| **Snapshot** | The rolling state built by `window.ts`: transcript of the last 30 s, latest captions, recent chat, bucketed activity (velocity, viewers trend, likes, gifts, joins) and per-source health. |
| **Tick** | One evaluation of all window questions (default every 1 s; 3× slower when the room is calm). |
| **Fired** | An answer meets its question's alert condition (`noulAbove`, `choices`, `scoreAtLeast`; choice/score also need confidence ≥ the confidence floor). |
| **Highlight / flag** | A durable card created when a question starts firing (edge-triggered, at most once per `highlightGapMs` for window questions) or when a message question fires. Carries what was flagged, the exact evidence jev judged, provenance (session, version, tick/message) and a severity (`warn` for moderation-like flags, `info` otherwise). |
| **GLM** | `z-ai/glm-5.3-flash`: the prompt writer. Turns rule text into jev questions, rewrites a question after feedback ("wrong"/"missed") or when jev stays unsure (auto-refine, off by default). Never on the hot path. |
| **Vision** | `z-ai/glm-4.6v`: captions a video frame in two sentences so jev can reason about the picture as text. |
| **Helpers** (`assist.ts`) | Built-in jev questions that run beside the rules: close answered prompts, fold duplicates, thank gifters, catch promises, match a FAQ, count polls, attention regime, budget degradation, self-repair, rule hygiene, retention, interruptibility. |
| **Session** | One connection: `live` (TikTok), `replay` (a recording played back at wall-clock speed, video synced) or `simulate` (a recording's MP4 pushed through the real media pipeline as if live). |
| **Director** | The host's screen (`/?view=director`): prompt queue, meters, dashboard, OBS overlay. |

## 3. Server

### 3.1 Runtime and service graph

The server is [Effect](https://effect.website) code run by Bun. `server/index.ts` builds one `ManagedRuntime` from
layers, then starts `Bun.serve` (`server/http.ts`):

```
SettingsStore ─► Bus ─► Gate ─► Jev, Glm
               Window, Store
               Session (uses all of the above)  ─►  Watcher (+ LiveProbe)
```

| File | Service / role |
|---|---|
| `config.ts` | `AppConfig`: environment variables (see [CONFIGURATION.md](CONFIGURATION.md)). |
| `settings.ts` | `SettingsStore`: live settings = `.env` defaults + `runtime/settings.json` overrides; `applyPatch` validates and clamps every field; secrets masked for the UI. |
| `bus.ts` | `Bus`: in-memory pub/sub to every WebSocket client, each message with a sequence number; ring buffers (200 events, 120 decisions, 300 message decisions, 50 GLM activities, 600 log lines) used to build `hello`; running cost totals; health record; the assist state and the current poll. |
| `gate.ts` | `Gate`: every OpenRouter call is admitted here (budget reservation, breaker, rate-limit wait) and uses `fetchWithTimeout` (AbortSignal). |
| `jev.ts` | `Jev.decide(state, questions)`: one decisions call, schema-validated answer, 6 s timeout, 2 retries on network/5xx/429 only. |
| `glm.ts` | `Glm.compileRule`, `Glm.refine`: chat-completions calls with a long system prompt that teaches GLM how to write good jev questions; output validated with Effect Schema (ids `^[a-z][a-z0-9_]{1,40}$`, 1–5 questions, alert consistent with the criteria). Rule text is passed as a JSON string, never as instructions. |
| `vision.ts` | `captionFrame(jpeg, previous)`: two-sentence literal description of a frame. |
| `window.ts` | `Window`: ingests every event and builds the `Snapshot` (buckets below). |
| `project.ts` | `projectWindow` / `projectMessage`: the state jev actually sees for a set of sources; `fingerprint`: the business content of a state, used to skip unchanged ticks. |
| `store.ts` | `Store`: rules, current question set, history, highlights (500 unpinned max, pinned never trimmed), feedback counts; 60 s undo trash; persisted atomically to `runtime/store.json` with a rolling backup. |
| `seed.ts` | The six starting rules and their hand-written questions (hype, host asks chat, reply needed, mood, message safety, asks host). |
| `session.ts` | `Session`: owns the one current session; start / stop / seek / record under a single semaphore. |
| `tiktok.ts` | `connectTikTok` (room info, FLV URL, event stream) and `isLive` (cheap probe). Uses `tiktok-live-connector` 2.5. |
| `media.ts` | `runMedia` (the live ffmpeg + Deepgram supervisor + caption loop), `runRecorder` (archive ffmpeg), `finalizeMp4`, `probeDuration`. |
| `deepgram.ts` | `transcribe`: Deepgram streaming WebSocket (nova-3, 16 kHz linear16, interim results, endpointing 400 ms). |
| `loop.ts` | `runLoops`: the window tick, the per-message workers and the auto-refine watchdog. |
| `assist.ts` | `runAssist`: the helpers; `startPoll` / `endPoll`; `retentionVerdict`; `purgePlan`. |
| `watch.ts` | `Watcher`: "is @user live?" polling, auto-connect and reconnect; state in `runtime/watch.json`. |
| `replay.ts` | Recordings: event sink (`.jsonl`), meta (`.meta.json`), listing, peek, search, moment context, timeline buckets, pattern testing, replay stream at wall-clock speed. |
| `http.ts` | Routes, auth, rate limits, WebSocket, static `dist/` (see [API.md](API.md)). |
| `fs.ts` | Typed fs helpers: atomic write (tmp + rename, mode), JSON read with schema, disk free. |
| `ratelimit.ts` | Fixed-window counter per IP. |

### 3.2 Session lifecycle (`session.ts`)

States: `offline → connecting → live → (ending) → offline | error`. All transitions run under one permit; every late
callback (stream end, ffmpeg exit, finalize) checks it still belongs to the current session before acting.

`start({username | replayId, offsetMs, simulate})`:

1. Ends the previous session if any. Builds an id `<username>-<ISO time>` used for every file of the session.
2. `live`: `connectTikTok` → room info must say live (status 2) → FLV pull URL (HD1, else FULL_HD1, SD1, SD2, RTMP)
   → socket connect. No FLV URL = chat-only session.
   `replay`: loads `recordings/<id>.jsonl` (no media pipeline). `simulate`: loads the recording and feeds its MP4 to
   the media pipeline in real time (`-re -stream_loop -1`).
3. Media pipeline under supervision: if ffmpeg exits it is restarted up to 3 times (2 s, 4 s, 6 s), then the session
   ends with an error.
4. Events recorder opened (`recordings/<id>.jsonl`); archive recorder started when `media.recordVideo` is on.
5. Loops (`runLoops`) and helpers (`runAssist`) start in the session's scope.
6. `start` resolves when the boot reached step 5, or fails after 90 s.

`endSession` (stream ended, error, disconnect, replaced, server shutdown): stops the archive (SIGINT, then finalize to
a seekable MP4 in the background), writes the meta (stats, retention verdict), closes scopes (kills ffmpeg, stops
loops), publishes a `SessionSummary`, clears the live data on every client (`reset` message), deletes the HLS
directory. Rules, versions, settings, highlights and the log survive a session.

Boot recovery: recordings whose meta has a video without `endTs` (server crashed) are probed, finalized and closed.

Every 30 s the server writes free disk space to health, logs under 2 GB, and (retention helper on) deletes
expendable recordings when free space is under `assist.diskFloorGb`.

### 3.3 Media pipeline (`media.ts`)

One ffmpeg process pulls the FLV once (`-reconnect 1 …`) and fans it out:

| Output | Settings | Consumer |
|---|---|---|
| HLS, 2 s segments, `program_date_time`, list size = `dvrMinutes`, old segments deleted | `media.hls`, `media.dvrMinutes` | Browser player via `/hls/live.m3u8` (DVR review) |
| JPEG `runtime/frames/latest.jpg` + 16×9 grayscale thumbnail, every `frameEverySec`, atomic writes | `media.vision`, `frameWidth`, `frameEverySec` | Caption loop |
| 16 kHz mono s16le PCM on stdout | always (dropped if transcription off) | Deepgram supervisor |

- **PCM pump**: always drains stdout into a sliding queue of 256 chunks (~2 min) so ffmpeg never blocks.
- **Deepgram supervisor**: reconnects with exponential back-off (max 30 s); gives up after 6 failed handshakes (bad key)
  and marks the transcript source `error`, so jev reads "(audio unavailable)" instead of "(silence)". Estimated cost
  logged per minute of audio ($0.0092/min multi, $0.0077/min single language, list price).
- **Captions**: every `timing.captionEveryMs`, only if the frame changed (mean absolute difference ≥ 6 on the
  thumbnail) or every 5 periods anyway; exponential back-off on failure; video source marked `error` after 3 failures;
  paused at budget degradation level 1.
- **Archive** (`runRecorder`): a second ffmpeg, stream copy to a fragmented MP4 (survives a kill), so REC start/stop
  is independent of the live pipeline. On stop: SIGINT, wait (3 s, then SIGKILL), remux to a faststart MP4 through a
  temp file + rename. Several clips per session: `<id>.mp4`, `<id>.rec2.mp4`, …

### 3.4 The rolling window (`window.ts`) and what jev sees (`project.ts`)

The snapshot keeps the transcript of the last `timing.windowMs` (30 s, cut to 1,500 chars), the last 2 captions, the
last 15 chat messages of the last 60 s (200 chars each), and buckets activity:

| Field | Buckets |
|---|---|
| `chat_velocity` (messages in 30 s) | 0 silent · ≤2 quiet · ≤8 steady · ≤25 busy · more flood |
| `viewers_trend` | viewer count now vs. the oldest count of the last 90 s: < −10 % falling · > +10 % rising · else flat |
| `likes_last_30s` | 0 none · ≤20 few · ≤150 many · more burst |
| `new_joins_last_30s` | 0 none · ≤5 few · more many |
| `gifts_last_60s` | the last 5 gift descriptions of the last 60 s |

Projection for a **window** question, by sources:

```jsonc
{
  "host_speech_last_30s": "…",          // transcript; "(silence)" or "(audio unavailable)"
  "video_scene": ["…", "…"],            // video; "(no frame yet)" or "(video unavailable)"
  "chat_recent": [{ "handle": "…", "text": "…", "secs_ago": 4 }],   // chat
  "activity": { "chat_velocity": "busy", "new_joins_last_30s": "few",  // chat only
                "viewers": 812, "viewers_trend": "rising", "likes_last_30s": "many", "gifts_last_60s": [] }
}
```

For a **message** question: `{ message: {handle, nickname, text}, context: { previous_chat (8), host_speech_last_30s?, video_scene? } }`.

### 3.5 Decision loops (`loop.ts`)

**Window tick** (fixed rate: the period includes the call):

1. Build the snapshot, publish it, record `lastTickAt`.
2. Keyword questions: regex on the transcript and recent chat (noul 1 or 0).
3. Remote questions grouped by sources. A group whose **fingerprint** (content, not timestamps or raw viewer count)
   is unchanged since its last call reuses the previous answers (no call), unless `maxTickGapMs` (15 s) has passed.
4. Groups are asked in parallel (concurrency 4). A failing group does not fail the tick: its questions are `skipped`
   and **keep their previous fired state** (an outage is not a "no", and its return is not a new alert).
5. `Decision` published (answers, fired, skipped, cached, partial, cost, latency).
6. Questions that **just started** firing (edge) and have not fired within `highlightGapMs` create one highlight.
   A highlight with nothing to show (stream just started) is skipped and retried.
7. Per-question confidence EMA and low-confidence samples are kept for auto-refine.

**Per-message judging**: chat events go into a sliding queue (`budget.chatQueue`); 16 workers, of which at most
`decisions.messageConcurrency` judge at once. A message older than `chatMaxAgeMs` when its turn comes, or beyond
`chatPerMinute`, is not judged (keyword rules still run); drops are counted in health and logged every 5 s. A fired
message question creates a `message` highlight with the message, context and evidence.

**Auto-refine watchdog** (off by default, live only): every `autoRefine.intervalMs`, a question whose confidence EMA
is below `emaBelow` with at least `minSamples` unsure samples, and not refined within `cooldownMs`, is rewritten by
GLM. The rewrite is applied only if the question set has not changed meanwhile (optimistic version check).

**Dry run** (`replay.dryRun`, replays only): no jev/vision/GLM call at all; keyword rules still fire; remote
questions show as "not evaluated".

**Severity**: a flag is a `warn` when a choice answer looks like moderation (`hostile|spam|scam|toxic|abuse|harass|…`)
or the rule text is about moderation; otherwise `info`.

### 3.6 Helpers (`assist.ts`)

Each helper is a small jev question under its own budget (`assist.sessionUsd`, default $0.50), never in a dry run.

| Helper | Trigger | Effect |
|---|---|---|
| Close answered prompts (`autoResolve`) | host speech, debounced 12 s | An open "reply to" card younger than 10 min whose question the host answered → resolved "answered". |
| Fold duplicates (`dedupe`) | new message flag | Same question as an open card → folded into it ("+3 asked the same"). |
| Thank gifters (`thanks`) | gift ≥ `thanksMinDiamonds` | "Thank X for Lion" card; closed when the host says the name (no call) or jev hears a thank-you; expires after 4 min. |
| Promises (`promises`) | host speech | "In 5 minutes the giveaway" → card with a due time (overdue in red). |
| Prepared answers (`faq`) | flagged question | Matched against `faqText` (`question => answer` per line, ≤ 40); the answer is shown on the card. |
| Live polls (`poll`) | chat message while a poll runs | Each message read as a vote, first vote per viewer counts. |
| Attention regime (`regime`) | every 30 s | calm / normal / hot; calm ticks 3× slower. |
| Budget degradation (`degrade`) | every 30 s, when `budget.sessionUsd` > 0 | Alert at 80 % of the session budget. From 60 % spent, jev chooses from the spend share, spend rate and elapsed time: keep all, level 1 (vision paused) or level 2 (chat judging paused too; room rules stay). Back to level 0 under 50 %. |
| Self-repair (`repair`) | every 30 s on anomalies | ffmpeg exited, Deepgram flapping, stalled ticks, repeating transcript, frozen captions, chat flood with no flags → `restart_media` / `disable_transcription` applied (once per 5 min), `reconnect` / `alert` suggested in the health bar. |
| Rule hygiene (`ruleHygiene`) | every 10 min | keep / refine / pause / remove per rule from fires, verdicts and confidence; shown in the Rules tab with Apply. |
| Retention (`retention`, off by default) | session end | Recording tagged keep / ok / expendable; below `diskFloorGb` expendable ones are deleted oldest first, never the current one. |
| Interruptibility (`interruptibility`) | every 10 s (free without a call when the host said nothing for 20 s) | free / talking / busy; the director holds plain chimes while busy (≤ 1 min); warnings always ring. |

### 3.7 Cost control (`gate.ts`)

- **Admission**: each paid call reserves an estimate (jev $0.00003, vision $0.0002, GLM $0.001) before it starts and
  settles after. If `spent + reserved + estimate > budget.sessionUsd`, the call is refused, logged once, and the health
  bar says so. Recording never stops for budget reasons.
- **429**: a shared "not before" time from `Retry-After` (or exponential 2 s…60 s) pauses every loop at once.
- **401 / 402**: circuit breaker open 5 min (bad key / no credit); reset when the key or budget is saved.
- **Timeouts**: requests are aborted; a timed-out call is not retried (it may still be billed: cost kind `unknown`).
- Every log entry carries running totals (`session`, `boot`, per actor, `estimated`, `reserved`).

### 3.8 Watcher (`watch.ts`)

Armed by: a successful live connect when `tiktok.resume` is on, `tiktok.autoConnect`, `TIKTOK_USERNAME` at boot, or
`POST /api/watch`. While armed and no session runs, it checks `isLive` every `tiktok.pollSec` (≥ 20 s), retries 10 s
after a drop, backs off on errors (≤ 10 min), and connects when live. Disarmed by Disconnect, a replay, or the API.
State persisted in `runtime/watch.json`, so a server restart picks the live back up.

### 3.9 Persistence

| Path (default; see `JEV_RUNTIME_DIR`, `JEV_RECORDINGS_DIR`) | Content |
|---|---|
| `runtime/store.json`, `store.backup.json` | Rules, question set + history, highlights, feedback. Atomic, mode 600; a corrupt file is moved aside and the backup tried. |
| `runtime/settings.json` | Only the settings that differ from `.env`; a secret equal to its `.env` value is never written. Mode 600. |
| `runtime/watch.json` | Watcher armed + username. |
| `runtime/hls/` | Live HLS (deleted at session end). |
| `runtime/frames/` | Latest frame and thumbnail. |
| `recordings/<id>.jsonl` | Every `LiveEvent` of the session, one JSON per line (interim transcripts excluded). |
| `recordings/<id>.meta.json` | `{ username, title, startedAt, endedAt, videos: [{file, startTs, endTs}], stats, keep, keepReason }` |
| `recordings/<id>.mp4`, `<id>.recN.mp4` | Archive clips (stream copy). |

`<id>` = `<username>-<ISO time with : and . replaced by ->`, e.g. `russell.d.ockham-2026-11-08T02-03-32-966Z`.

## 4. Web (`web/`)

React 19, built by Vite into `dist/` (served by the Bun server in production; Vite dev server on :5173 proxies
`/api`, `/hls`, `/recordings`, `/ws` to :3001 in development).

| Path | Role |
|---|---|
| `main.tsx` | Boot: `?token=` / legacy token → login → `/api/auth` → `<App>` (console) or `<Director>` when `?view=director`. |
| `lib/store.ts` | External store (`useSyncExternalStore`), reducer over server messages; `startSocket` buffers messages until `hello`, then applies only `seq > hello.seq`, dedupes, reconnects with back-off, shows the sign-in on 401. |
| `lib/api.ts` | Typed REST client (timeouts, abort, error toasts). |
| `lib/hotkeys.ts` | One key map per view; bare keys only, never while typing. |
| `lib/prefs.ts` | Per-browser preferences in `localStorage` (`jev.*`). |
| `lib/audio.ts`, `lib/notify.ts` | Chime (generated tones) and browser notifications. |
| `App.tsx` + `components/` | The console (see [USAGE.md](USAGE.md)). |
| `Director.tsx` + `director/` | The host's screen: `model.ts` (pure logic: card selection, meters, URL overrides), `views.tsx` (layouts), `widgets.tsx`. |
| `i18n/` | English / French strings; each component keeps its own `M = { en, fr }` table. |

Shared types between server and web live in `shared/protocol.ts` (`PROTOCOL_VERSION = 2`; the console asks for a
reload when the server's protocol differs).

## 5. Invariants worth keeping

- No paid call outside `Gate.admit` / `fetchWithTimeout`.
- Text from users or the stream reaches GLM/vision as quoted data, never as instructions.
- A skipped (failed) question keeps its previous fired state.
- Every session transition goes through the `Session` semaphore; late callbacks check identity.
- Files under `runtime/` are written atomically; secrets never reach the browser in full.
- Everything a client needs to render is in `hello`; every later change is a message with a higher `seq`.
- The web unit tests require 100 % line coverage and must pass in any file order (see [DEVELOPMENT.md](DEVELOPMENT.md)).
