# tiktok:jev — improvement plan

_Audit date: 2026-09-20 · commit `5d6400c` · 16 commits, ~4,400 lines, 0 tests_

This document is the result of a full pass over the server (Bun + Effect), the web console (React + Vite),
the director view and the shared protocol, plus measurements taken against live streams during the day.
It lists what is wrong or weak, why it matters, and a phased plan to make the app dependable enough to run
unattended for a multi-hour stream.

---

## 1. Where the app stands

**What works and was verified live**: TikTok connection, ffmpeg fan-out (HLS DVR, frames, PCM), Deepgram
transcription, GLM-4.6v captions, jev decisions every second and per chat message, GLM rule compilation and
refinement (manual and automatic), durable highlights, activity log with costs, live settings, recordings with
video clips, replay with seek, timeline with search / go-to / back-to-live, director overlay.

**Measured**

| Metric | Value |
|---|---|
| jev round trip | 300–500 ms (26 questions cost no more than 1) |
| jev cost | ≈ $0.08 / h at 1 Hz with 5 room questions + per-message calls |
| vision cost | ≈ $0.07 / h at one caption / 6 s (the most expensive call per minute) |
| GLM | ≈ $0.0003 per compile or refine, 10–35 s each |
| Disk | ≈ 1–2 GB / h **twice** during a live: HLS DVR + MP4 recording |
| Production build | works, 928 KB, one chunk (hls.js) |
| Tests | none; no lint |

**Structural weaknesses** (the themes behind most findings below)

1. **Session lifecycle is a mutable global** (`let session`) mutated from unserialised HTTP handlers and
   daemon fibers. Every race in the audit traces back to this.
2. **Errors are hidden**: `Effect.promise` on fallible calls turns failures into defects that `catchAll` and
   `ignore` never see, so a full disk or a missing ffmpeg silently kills a loop while the UI says "live".
3. **The whole console re-renders on every WebSocket message**, and the timeline re-renders at 60 fps.
4. **No back-pressure or budget** on paid calls: a chat flood queues an unbounded number of jev calls.
5. **Persistence is not atomic** and a corrupt `store.json` silently resets every rule.
6. **Nothing is tested**, and the boundaries (WS messages, HTTP bodies) are untyped at runtime.

---

## 2. Findings

Severity: **C** critical (data loss, silent failure, money), **H** high, **M** medium, **L** low.
Each item has a file reference and a fix; the phases in §3 group them into work packages.

### 2.1 Server: correctness and resilience

| # | Sev | Finding | Fix |
|---|---|---|---|
| S1 | C | **One Deepgram disconnect stalls everything.** `transcribe` is retried on the same `proc.stdout` iterator; after the first cancel it yields nothing, and on a clean close (1000) nobody drains stdout at all. ffmpeg's pipe fills, it blocks, and HLS, MP4 and frames all freeze while status stays "live". `media.ts:56-65`, `deepgram.ts:34-43` | One fiber always drains stdout into a bounded sliding queue; Deepgram consumes from it and restarts on end or error with exponential backoff. |
| S2 | C | **Overlapping sessions leak processes.** `startSession` checks `session`, yields through `stopSession`, then assigns. Two `connect`/`seek` calls (double click, arrow spam) both pass, the loser's scope is never closed: orphan ffmpeg, Deepgram socket, tick loop still spending. Daemon `endSession` from a finished replay can also tear down a newer session. `index.ts:37,141,223,238,345,371` | `Session` as a service holding a `SynchronizedRef`; start/stop/seek under a `Semaphore(1)`; `endSession(me)` no-ops unless `session === me`. |
| S3 | C | **Defects instead of failures.** `Effect.promise` wraps `writeFile`, `appendFile`, `mkdir`, `rm`, `res.text()`, `Bun.write`; `Bun.spawn` throws synchronously if ffmpeg is missing. ENOSPC on `store.json` kills the tick loop for good; a failed append kills event ingest without ending the session. `store.ts:31`, `settings.ts:90`, `replay.ts:10,36`, `media.ts:28,49`, `index.ts:99-119,162,180`, `jev.ts:57` | `Effect.tryPromise`/`Effect.try` with typed errors; loops use `catchAllCause` (log, continue); runtime `unhandledErrorLogLevel: Error`; `/api/health`. |
| S4 | C | **Finalize can overwrite the only copy with a truncated file.** For the automatic recording, `finalizeRecording` remuxes while the main ffmpeg is still writing (kill not awaited), then `Bun.write` copies the result over the original. `index.ts:75,108-130` | Close the media scope, await `proc.exited` (SIGINT then SIGKILL), then remux to tmp and `rename()`. |
| S5 | H | **Replayed transcripts never reach jev.** `replayEvents` re-stamps `ts` but not `endTs`; the window stores `endTs`, so replayed speech is pruned immediately and `transcript_last_30s` is empty in every replay. `replay.ts:22`, `window.ts:44` | Shift `endTs` by the same delta. Add a test. |
| S6 | H | **Non-atomic, unserialised persistence; corrupt file = silent reset to seed.** Concurrent `writeFile`s from tick, judge, HTTP and watchdog; every highlight rewrites a multi-MB file. `store.ts:20-32`, `settings.ts:78-91` | tmp + rename, a single debounced writer fiber, `Schema` validation on load, move corrupt files aside, keep a rolling backup. |
| S7 | H | **A failing source group discards the paid answers of the others.** `Effect.all` fails as a whole; no decision published. `loop.ts:93,146` | `Effect.partition`, merge successes, publish a partial decision, log failures. |
| S8 | H | **ffmpeg exit and TikTok socket drop are never observed.** `media.ts:49`, `tiktok.ts:39` | Watch `proc.exited` (bounded restart or end session); subscribe to the connector's disconnect event. |
| S9 | M | **Seek restarts the whole session** and wipes persisted unpinned highlights, re-parses the file, re-runs loops. `index.ts:367` | Seek = interrupt the replay stream and reset the window only; parse once per replay. |
| S10 | M | **Disconnect during connect leaves a half-live state.** `index.ts:139-243` | Run `connectTikTok` inside the scope; gate status updates on session identity. |
| S11 | M | Vision loop: no backoff, reads `latest.jpg` mid-write, captions static pictures. `media.ts:46,71-100` | `-atomic_writing 1`; backoff; skip when the JPEG hash is unchanged. |
| S12 | M | GLM retries deterministic failures (400/401/402, invalid JSON); duplicate ids inside one batch; generated alerts not validated against criteria. `glm.ts:77-97` | Retry only timeout/429/5xx; dedupe; validate `alert.choices ⊆ keys`, `scoreAtLeast < levels`. |
| S13 | M | Deepgram reconnect every 2 s forever, even on 401. `media.ts:63` | Exponential backoff, stop on auth errors. |
| S14 | L | Dead log line after `return` (`media.ts:103`); zombie `ffprobe` (`index.ts:182`); `health` map never forgets removed questions; `hlsStartTs` taken before the first segment. | Small fixes. |

### 2.2 Server: cost and performance

| # | Sev | Finding | Fix |
|---|---|---|---|
| P1 | H | **Unbounded per-message jev backlog** on a chat flood: unbounded PubSub subscription + `mapEffect`; every queued message is billed minutes later. `loop.ts:165` | Sliding queue; drop messages older than 10 s; per-minute budget in settings; read concurrency live. |
| P2 | H | **No global backoff on 429/402/401, no request abort.** Timed-out fetches keep running and are billed; limited calls are retried up to 3× per group per second. `jev.ts:48-73`, `vision.ts`, `glm.ts` | `fetch` with `AbortSignal`; shared `nextAllowedAt` honouring `Retry-After`; circuit breaker on 401/402 surfaced in the UI. |
| P3 | H | **Idle streams still cost full price.** A silent stream with no chat is 3,600 identical jev calls per hour. | Skip the tick when the projected state hash is unchanged; degrade the tick rate when idle; session budget with a hard stop. |
| P4 | M | **Disk and bandwidth ×2–3**: DVR HLS keeps every segment, the MP4 duplicates it, an on-demand clip pulls the FLV a second time. `media.ts:42`, `index.ts:50` | Record once (MP4) and serve DVR from it by byte range, or cap the DVR; derive clips by `-ss/-to -c copy` from the recording. |
| P5 | M | **Recorder: open/close per event; interim transcripts recorded; every search/timeline/listing re-parses whole files and spawns ffprobe.** `replay.ts:8`, `index.ts:229` | One writer per session; skip interims; in-memory index for the live session; cache parsed recordings by (path, size, mtime); summary stats in `meta.json`. |
| P6 | M | Replay and simulate spend real money and auto-refine mutates the persisted question set from replayed data. `loop.ts`, `index.ts:153` | `dryRun` / replay budget; auto-refine off in replay; no auto-record in simulate. |
| P7 | L | Bus copies the ring buffer on every publish; `hello` ships ~1.3k log rows + 500 highlights. `bus.ts:20` | Mutable ring; paginate log on connect. |

### 2.3 Server: security and API

| # | Sev | Finding | Fix |
|---|---|---|---|
| X1 | H | **No auth, bound to all interfaces, path-controlled inputs.** Anyone on the LAN can rewrite API keys, start sessions, delete recordings; `replay` is a raw path; `username` reaches a file path; `deleteRecording` trusts `meta.videos[].file`. `index.ts:329-345`, `replay.ts:124` | Bind `127.0.0.1` by default; bearer token (env) on `/api` and `/ws`; recording ids `^[\w.-]+$` resolved inside `recordings/`; `path.basename` everywhere. |
| X2 | M | **Secrets persisted world-readable**; TikTok cookie persisted; `.gitignore` misses `recordings/*.mp4` and `*.meta.json`. Note: a key was printed into an audit transcript today — **rotate the OpenRouter key and the TikTok session id**. | `mode: 0o600`; don't persist values equal to the `.env` default; ignore `recordings/` entirely. |
| X3 | M | Bodies are not validated: highlight PATCH spreads the raw body over the stored object; `Boolean("false")`; `{tiktok:null}` → 500; any unknown clear mode = "all". `index.ts:389-427`, `settings.ts:36` | Decode bodies with `Schema` (or `@effect/platform` `HttpApi`); uniform `{ok:false,error}` envelope. |
| X4 | M | `connect` and `seek` answer `{ok:true}` before anything happens. | Await boot to connected/failed, or 202 with a request id echoed in the status event. |
| X5 | L | Range requests: suffix ranges and out-of-range give wrong results; segments served `no-store`; prompt injection surface in vision/GLM prompts. | RFC 7233 handling, cache segments, delimited JSON fields in prompts. |

### 2.4 Web: correctness and state

| # | Sev | Finding | Fix |
|---|---|---|---|
| W1 | C | **Toasts never auto-dismiss during a live**: `dismissToast` is a new function every render, the timer effect depends on it, and the console re-renders every second. `Toasts.tsx:6`, `useSocket.ts:100` | Stable callbacks (`useCallback`/dispatch); key the timer on the first toast's id. |
| W2 | C | **`messageDecisions` grows forever** and `Object.keys(decisions).length` in a dependency array walks it on every message. `useSocket.ts:75`, `ChatFeed.tsx:60` | Prune with the chat cap; counter in the reducer. |
| W3 | C | **No error boundary**; a malformed highlight or an unknown kind blanks the console and the OBS overlay. `main.tsx:6` | Root and per-panel boundaries with a reload action; guard `JSON.parse`; validate WS messages. |
| W4 | C | **Shortcuts fire with modifiers**: Cmd+D, Cmd+S, Cmd+1..8, Ctrl+R; bare `r` stops a recording with no confirmation. `App.tsx:73`, `Director.tsx:77` | Ignore modified keys; confirm stop-recording; one `useHotkeys` map shared with the help sheet. |
| W5 | H | **Two contradictory "session spend" numbers** (header sums everything received; log tab sums the last 600 rows). `useSocket.ts:92`, `ActivityLog.tsx:15` | Server-side running totals in `hello` and on each log entry. |
| W6 | H | **Timeline click leaves a stale review strip** and search hits are never highlighted in it (`q` not passed). `App.tsx:53,147` | Fetch context on every seek (debounced); pass the query. |
| W7 | H | **Header viewer sparkline is flat** (maps decisions to the current count). `App.tsx:101` | Ring buffer of viewer events in the reducer. |
| W8 | H | **Director URL params are persisted** to the shared prefs: opening the OBS source once makes the normal window transparent forever. `Director.tsx:69` | URL params as a non-persisted override layer. |
| W9 | H | **`chime()` creates an AudioContext per alert**; after the browser cap it silently stops. `Toasts.tsx:26` | One lazy context, resumed on the first gesture. |
| W10 | H | **Reset drops highlights client-side** although the server keeps them; no "stream ended" state. `useSocket.ts:91` | Keep highlights; add an end-of-session summary. |
| W11 | M | Settings: focusing a masked secret wipes it (a blank save could clear the key); numbers coerce to 0 bypassing min/max; nav highlight not synced to scroll. `Settings.tsx:84-89,109` | Keep the mask until typed; validate before enabling Save; `IntersectionObserver`. |
| W12 | M | HLS seek fragility: silent fallback to the start when the moment is outside the DVR window; seek lost before the manifest is parsed; unbounded media-error recovery; Safari path does nothing. `VideoPane.tsx:32-65` | Queue the pending seek until `LEVEL_UPDATED`; "moment not in window"; cap recovery + `swapAudioCodec`; `getStartDate()` on Safari. |
| W13 | M | Dead code: `Alerts.tsx` and the `alerts` reducer branch; duplicated `answerText`, avatar, duration helpers, moderation regex (two different word lists). | Delete; `web/lib/format.ts`, `<Avatar>`, `usePref`; server tags highlights with `severity`. |
| W14 | L | CSV export not RFC-4180 safe; `initials()` splits emoji; replay `<select>` uncontrolled; `Choice` gauge hides options beyond 6. | Small fixes. |

### 2.5 Web: performance

| # | Sev | Finding | Fix |
|---|---|---|---|
| R1 | H | **Whole-app re-render per WS message**; derived arrays and inline lambdas defeat every `memo`. `App.tsx:26-102`, `Gauges.tsx:100`, `ChatFeed.tsx:81` | Split state into slices (`useSyncExternalStore` or contexts); memoize derived arrays; pass primitives; memoize heavy panels. |
| R2 | H | **Timeline re-renders at 60 fps and re-registers its keyboard listener every frame**; `marks` memo keyed on `now`. `Timeline.tsx:32,43,65` | 4–10 Hz tick or imperative playhead; refs for handler state; coarse `endTs`. |
| R3 | H | **`key={tab}` remounts panels**: unsaved settings, filters, selections and polls are lost on every tab switch. `App.tsx:172` | Keep panels mounted (`hidden`); guard unsaved changes. |
| R4 | H | Transcript lines keyed by index: every new line past 80 remounts all rows and replays the animation. `Transcript.tsx:38` | Stable ids from the server. |
| R5 | M | `onPlayingTs` forces a render twice a second even when nothing changed; Versions deep-diffs with `JSON.stringify` on every render. `VideoPane.tsx:68`, `Versions.tsx:43` | Skip identical updates; `useMemo` the diffs. |
| R6 | M | 928 KB single chunk; Google Fonts blocks first paint and leaks the streamer's IP in OBS. `index.html:7` | Code-split hls.js; self-host fonts. |

### 2.6 Web: UX, accessibility, responsiveness

| # | Sev | Finding | Fix |
|---|---|---|---|
| U1 | M | Native `prompt`/`confirm`/`alert` for feedback and deletes: blocking, unstyled, single-line, unusable in OBS. `Flagged.tsx:37`, `Gauges.tsx:63`, `Recordings.tsx:38`, `Settings.tsx:143` | In-app `<dialog>` with a textarea; undo toasts for deletes. |
| U2 | M | Deleting a highlight, a rule or "clear handled" has no confirmation or undo; Versions has no rollback (the seed rules were removed today and cannot be restored from the UI). | Soft delete + undo; "restore this version". |
| U3 | M | Accessibility: clickable `<div>`s without roles or keyboard access; `aria-live` on every gauge floods screen readers; tabs without `aria-controls`; help dialog without focus trap; icon-only buttons without labels; timeline without `role="slider"`. | Buttons for actionable rows; one summary live region; complete tab pattern; native `<dialog>`; labels. |
| U4 | M | Responsive: search hidden under 1100 px while ⌘K still focuses it; horizontal overflow between 1100 and 1250 px; toasts cover content on phones. `styles.css:92,266,431` | Command palette at small widths; `minmax(0,1fr)`; toast width clamp. |
| U5 | M | ←/→ hijacked globally (breaks selects and sliders); Escape blurs everything. `Timeline.tsx:71`, `App.tsx:71` | Scope arrows to body/track focus; layered Escape. |
| U6 | M | Rules cannot be edited, paused, reordered or recompiled; example chips overwrite typed text; no cost hint per rule. | Pause toggle (server skips), inline edit → refine, "$/h" estimate. |
| U7 | M | No i18n: English literals over French content; `lang="en"` on French text. | Minimal `t()` with en/fr; `lang` from the speech setting on content regions. |
| U8 | L | CSS: one 445-line file, multi-rule lines, dead selectors, raw hex in `button.primary`, no light theme. | Split by surface; tokens for breakpoints. |

### 2.7 Missing features a streamer or moderator expects

1. **Gift / follow / join / like feed** and top-gifter board: the data arrives (`GiftEvent`, `SocialEvent`, `MemberEvent`, `LikeEvent`) and is discarded.
2. **"Watch this moment"** on every flagged card and toast: highlights carry `ts`, the DVR exists, but only search reaches the video. Plus **"clip ±30 s to MP4"**.
3. **Per-user context**: click a handle → their messages, flag history, follower badge, "mute this user's alerts".
4. **Cheap keyword / regex rules** that fire without a jev call (banned words, links, phone numbers).
5. **Notification channels**: browser `Notification` when hidden, webhook / Discord for warnings, distinct chime per kind.
6. **Stream-end summary and export**: highlights to CSV/Markdown, spend, viewer peak, what fired most.
7. **Chat filters**: flagged only, by question, by user, plus search over the live buffer.
8. **"Why did this fire"**: show the exact excerpt jev saw (today only sent on disagree).
9. **Layout persistence and light theme**; **mobile moderator layout** (single column, chat + flagged).
10. **Rollback** of question-set versions; **rule templates** library.

---

## 3. Plan

Five phases. Each phase leaves the app in a shippable state. Effort is in engineer-days for one person who
knows the code.

### Phase 0 — Stop the bleeding (2 days)

Small, isolated fixes with outsized impact. No architecture changes.

| Task | Refs | Acceptance |
|---|---|---|
| Rotate the OpenRouter key and the TikTok session id; `chmod 600` on `runtime/*.json`; ignore `recordings/` entirely | X2 | new key in `.env`; `git status` clean after a session |
| Decouple the PCM pump from Deepgram (bounded sliding queue, restart on end and error with backoff) | S1, S13 | kill the Deepgram socket mid-stream: HLS keeps growing, transcript resumes within 10 s |
| Fix replayed `endTs` | S5 | replay shows host speech in the state tab; unit test |
| `Effect.partition` over source groups | S7 | one group failing still publishes the others |
| Await ffmpeg exit before finalizing; tmp + `rename` | S4 | a session stopped mid-write yields a playable, complete MP4 |
| Toast timer keyed on toast id; stable callbacks | W1 | toasts leave after `toastMs` during a live |
| Prune `messageDecisions` with the chat cap | W2 | heap flat over a 1 h replay |
| Root + per-panel error boundaries; guard `JSON.parse` | W3 | inject a bad highlight: panel shows an error card, video keeps playing |
| Ignore modified keys; confirm stop-recording | W4 | Cmd+S no longer toggles the chime |
| Bind `127.0.0.1` by default; recording ids validated; `path.basename` on meta files | X1 | `/api/connect {replay:"../.env"}` → 400 |
| Delete `Alerts.tsx` and the `alerts` state | W13 | — |

### Phase 1 — Make the session lifecycle correct (4 days)

| Task | Refs | Acceptance |
|---|---|---|
| `Session` service: `SynchronizedRef`, `Semaphore(1)` around start / stop / seek, identity-checked `endSession` | S2, S10 | 20 concurrent `connect`/`seek` calls → exactly one ffmpeg, one Deepgram socket, one tick loop; `ps` clean after disconnect |
| Replace every `Effect.promise` on fallible calls with `tryPromise` + typed errors; `catchAllCause` in loops; `unhandledErrorLogLevel: Error` | S3 | fill the disk in a test: tick loop keeps running, log shows the write error |
| Observe `proc.exited` and the TikTok disconnect event | S8 | kill ffmpeg: session ends (or restarts) within 5 s with a log line |
| Seek without restarting the session (interrupt the replay stream, reset the window, keep highlights) | S9 | arrow-key spam keeps the highlight list; seek latency < 200 ms |
| Atomic, serialised, validated persistence with backup | S6 | truncate `store.json` mid-write: boot keeps the last good version |
| Body validation with `Schema`; uniform error envelope; `connect`/`seek` await the outcome | X3, X4 | fuzz the routes: no 500s |
| `/api/health` (ffmpeg pid, Deepgram state, last tick, backlog) and a header indicator | S3 | — |
| Tests: `bun test` for `applyPatch`, `projectWindow`, `isFired`, `groupBySources`, `merge`, `Window.snapshot`, `replayEvents`, `searchEvents`; integration test with a fake TikTok stream and a stub jev layer asserting no fiber survives `endSession` | all | CI green |

### Phase 2 — Cost, back-pressure, disk (3 days)

| Task | Refs | Acceptance |
|---|---|---|
| Chat sliding queue + age cutoff + per-minute budget; concurrency read live | P1 | 100 msg/s flood: backlog ≤ N, oldest dropped, spend bounded |
| `AbortSignal` on every fetch; shared `Retry-After` gate; circuit breaker on 401/402 shown in the UI | P2 | simulate 429: at most one request per gate window; 402 stops calls and shows a banner |
| Skip identical ticks (state hash), idle tick degradation, session budget with hard stop | P3 | silent stream: jev spend < $0.01 / h |
| Record once: MP4 as the DVR source by byte range (or capped HLS); clips by `-ss/-to -c copy` | P4 | disk ≈ 1× stream bitrate; clip start/stop no longer spawns a second pull |
| Session writer (one fd), no interim transcripts, in-memory live index, cached parsing, stats in `meta.json` | P5 | `/api/search` on a 3 h session < 50 ms; `/api/recordings` no ffprobe |
| Replay `dryRun`, auto-refine off in replay, no auto-record in simulate | P6 | replay of a 1 h session costs $0 with dryRun |
| Vision: atomic frame write, hash skip, backoff | S11 | static picture: one caption per change, not per period |
| GLM: retry policy, id dedupe, alert validation | S12 | a compile that returns `alert.choices` outside the keys is rejected with a clear error |
| Server-side running cost totals | W5 | header and log tab agree |

### Phase 3 — Console performance and UX (4 days)

| Task | Refs | Acceptance |
|---|---|---|
| State slices with `useSyncExternalStore`; memoized derived data; primitives to memoized children | R1, R5 | React profiler: a `decision` message re-renders gauges only |
| Timeline at 8 Hz with refs; keyboard listener registered once; arrows scoped | R2, U5 | CPU < 3 % idle on the timeline |
| Panels stay mounted; unsaved-changes guard | R3 | edit settings, press `1`, come back: draft intact |
| Stable transcript ids; typed API client with `ok` check, timeout, abort; `try/finally` on every busy flag | R4, W-API | a 500 from any route shows a toast, buttons recover |
| Review strip follows every seek; hits highlighted; "moment not in DVR window"; queued seek; Safari mapping | W6, W12 | click the track: strip updates; seek before manifest: applied once loaded |
| Viewer sparkline from viewer events; events feed (gifts, follows, joins) | W7, feature 1 | — |
| In-app dialogs (feedback textarea, delete confirm) + undo toasts; version rollback | U1, U2 | delete a rule, press undo: rule and questions back, same version number |
| Director: URL overrides not persisted, dependency arrays, shared helpers, server-tagged severity | W8, W13 | OBS source and window keep separate looks |
| Single AudioContext for the chime | W9 | 50 alerts: chime still sounds |
| End-of-session summary instead of a blank console; keep highlights on reset | W10 | — |
| Accessibility pass: buttons, tab pattern, one live region, `<dialog>`, labels, slider semantics; `jsx-a11y` lint | U3 | axe: no serious violations |
| Responsive: command palette under 1100 px; `minmax(0,1fr)`; toast clamp; mobile moderator layout | U4 | no horizontal scroll from 375 px up |
| Self-host fonts; code-split hls.js | R6 | first paint without network; main chunk < 300 KB |

### Phase 4 — Features and polish (5 days, pick by value)

| Task | Refs | Notes |
|---|---|---|
| "Watch this moment" on cards and toasts; "clip ±30 s" | feature 2 | uses the seek and `-ss/-to` from Phase 2 |
| Per-user context panel, follower badge, mute user alerts | feature 3 | `userId` already on every message |
| Keyword / regex rules without jev | feature 4 | run in `judgeMessage` before the paid call; "match count" on the rule |
| Rule pause / edit / recompile; cost estimate per rule | U6 | pause = server skips the rule's questions |
| Notifications: browser `Notification`, webhook, chime per kind | feature 5 | settings section |
| Chat filters and live-buffer search | feature 7 | — |
| "Why did this fire" excerpt on highlights | feature 8 | attach the projected state to window highlights |
| Session export (CSV / Markdown) | feature 6 | from the store + log |
| i18n en/fr; `lang` on content regions | U7 | — |
| CSS split by surface; breakpoint tokens; light theme | U8 | — |
| Auth token for `/api` and `/ws` (needed once the director runs on another machine) | X1 | env `JEV_TOKEN`, `?token=` for OBS |

### Phase 5 — Architecture (optional, 3 days)

Only after Phases 0–2, and only if the app is to be maintained long-term.

- `@effect/platform` `HttpApi` with `Schema` for every route; the client generated from the same schema
  (typed API client for free, replaces the hand-written `api` object).
- A `Session` state machine (`idle → connecting → live → ending`) with explicit transitions instead of
  status strings scattered across handlers.
- Split `index.ts` (517 lines) into `routes/`, `session.ts`, `recording.ts`.
- Playwright smoke test that boots Vite against a replay and asserts the console, the director and the
  keyboard shortcuts.
- ESLint (`@typescript-eslint`, `react-hooks`, `jsx-a11y`) in `typecheck`; `bun test` and `vite build` in CI.

---

## 4. Order of execution and why

1. **Phase 0 first, in one sitting.** Every item is a real bug observed or provable today (the Deepgram
   stall, the finalize race, the exposed key, the toasts that never leave), none needs design, and together
   they remove the ways a stream can silently break.
2. **Phase 1 before any new feature.** The session lifecycle is the foundation for seek, clips, DVR and
   anything else that starts or stops a process. Building more on `let session` multiplies the races.
3. **Phase 2 before running unattended.** Without a budget and back-pressure, a viral moment (chat flood)
   or a provider outage (429 storm) turns into an unbounded bill; without the disk changes a 4 h stream
   writes 8–12 GB.
4. **Phase 3 makes the console pleasant** for a full stream: a 60 fps timeline and whole-app re-renders are
   fine for a demo, not for a laptop that also runs OBS.
5. **Phase 4 is where value differs per user**; pick by demand. "Watch this moment", gifts feed and
   keyword rules are the three most requested capabilities from a moderator's point of view.

**Definition of "perfect" for this app**: a 6-hour live with a chat flood and two provider outages ends with
a complete recording, a correct highlight list, a bill within the configured budget, no orphan process, and a
console that never went blank. Phases 0–2 get there; 3–4 make it a joy to use.
