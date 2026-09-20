# Implementation status

_2026-09-21 · implements `IMPROVEMENT_PLAN.md` (phases 0–4) and the P0/P1 findings of `PRODUCT_TECH_AUDIT_FR.md`._

Legend: ✅ done · ◐ partial · ✗ not done. File references point at the new layout: `server/session.ts` (lifecycle),
`server/http.ts` (routes), `server/gate.ts` (rate limit, breaker, budget), `server/fs.ts` (typed fs), `web/lib/*` (store,
api, hotkeys), `server/tests/*` (bun test).

## Phase 0 — stop the bleeding

| Ref | Status | What was done |
|---|---|---|
| X2 | ◐ | `recordings/` fully ignored and **unstaged** (`git rm --cached`, local files kept); `runtime/*.json` written with mode 0600; secrets equal to `.env` are no longer persisted. **Keys were printed again in this session's transcript: rotate the OpenRouter key, the Deepgram key and the TikTok session id.** |
| S1, S13 | ✅ | PCM is drained by its own fiber into a bounded sliding queue; Deepgram consumes from it and reconnects with exponential backoff; gives up after 6 failed handshakes (bad key) with a log line and a health state. `server/media.ts` |
| S5 | ✅ | Replayed `endTs` shifted with `ts`; the clock is read after the wait (audit C); `srcTs` keeps the original. Unit test. `server/replay.ts` |
| S7 | ✅ | `Effect.partition` over source groups; partial decisions carry `skipped` ids; a skipped question keeps its previous fired state (no false negative, no new alert edge on return). `server/loop.ts` |
| S4 | ✅ | The archive is its own ffmpeg process; stop awaits its exit (SIGINT then SIGKILL), remux goes to a temp file and `rename`s over the original only on success. Interrupted recordings are recovered at boot. Audit A fixed (REC stop is real). |
| W1 | ✅ | One timer per toast keyed on its id; callbacks stable. |
| W2 | ✅ | `messageDecisions` pruned with the chat cap. |
| W3 | ✅ | Root and per-panel error boundaries; WS messages validated; a crash shows a card, the video keeps playing. |
| W4 | ✅ | Shortcuts ignore ⌘/Ctrl/Alt; `r` asks for confirmation before stopping a recording; one hotkey map feeds the help sheet. |
| X1 | ✅ | Binds `127.0.0.1` by default (`HOST`); optional bearer token `JEV_TOKEN` on `/api`, `/ws`, `/hls`, `/recordings` (`?token=` for OBS / media); recording ids validated; `path.basename` on meta files. |
| W13 | ✅ | `Alerts.tsx` deleted; helpers unified in `web/lib/format.ts`, one `<Avatar>`, `usePref`. |

## Phase 1 — session lifecycle

| Ref | Status | What was done |
|---|---|---|
| S2, S10 | ✅ | `Session` service: `SynchronizedRef` + `Semaphore(1)` around start / stop / seek; every late callback checks session identity; status updates gated on identity; connect awaits "live" or failure (90 s timeout). |
| S3 | ✅ | `Effect.promise` on fallible calls replaced by typed errors (`FsError`, `MediaError`, `DeepgramError`, `GateError`); loops use `catchAllCause` (log, continue). `/api/health`. |
| S8 | ✅ | ffmpeg exit observed: bounded restart (3×) then session ends with an error; TikTok `DISCONNECTED` fails the stream so the session reacts. |
| S9 | ✅ | Replay seek interrupts the event fiber and resets the window; no re-parse (events cached by path/size/mtime); highlights kept. |
| S6 | ✅ | Atomic writes (tmp + rename), one debounced writer fiber, `Schema` validation on load, corrupt file moved aside, rolling backup. Tests. |
| X3, X4 | ✅ | Every body decoded with `Schema`; uniform `{ok:false,error}` envelope; connect / seek answer with the outcome. |
| tests | ✅ | 21 tests: settings, projection, fingerprint, decisions, keyword rules, severity, alert validation, replay clock, search, ranges, store persistence/recovery/undo/version restore, settings persistence, loop integration with a stub jev (partial decisions, cached ticks, no fiber after scope close), budget gate. CI workflow (`.github/workflows/ci.yml`). |

## Phase 2 — cost, back-pressure, disk

| Ref | Status | What was done |
|---|---|---|
| P1 | ✅ | Chat inbox = sliding queue (`budget.chatQueue`), age cutoff (`chatMaxAgeMs`), per-minute budget (`chatPerMinute`), concurrency read live; drops counted in health and log. |
| P2 | ✅ | `Gate`: `AbortSignal` on every fetch, shared `Retry-After` / 429 backoff, circuit breaker on 401/402 (5 min, reset on key save), surfaced in the health bar. Timeouts are never retried (a timed-out call may still be billed → `costKind: "unknown"`). |
| P3 | ✅ | Business fingerprint per source group (audit's objection honoured: `ts`, `secs_ago`, raw viewer count excluded; content expiry changes it); unchanged state = cached decision, forced re-ask after `maxTickGapMs`; session budget hard stop with reservation of an envelope before each call (audit H). |
| P4 | ◐ | Audit's short-term recommendation: HLS with a bounded DVR window (`media.dvrMinutes`, segments deleted) + independent archive process. Disk ≈ archive + window. Bandwidth is 2× (two pulls) while recording; clips by `-ss/-to` not done. |
| P5 | ✅ | One `FileSink` per session, interim transcripts not recorded, in-memory live index for search / context / timeline, parsed recordings cached, stats written to `meta.json` (no ffprobe when the meta has end times). |
| P6 | ✅ | `replay.dryRun` (zero paid calls), auto-refine never in replay/simulate, auto-refine off by default (audit F) and version-checked before commit. |
| S11 | ✅ | `-atomic_writing 1` on the frame; perceptual change gate on a 16×9 grayscale thumbnail (mean abs. diff ≥ 6, forced caption every 5 periods); exponential backoff on failures; video source marked "error" after 3 failures. |
| S12 | ✅ | GLM retries only network/429/5xx; ids deduped inside a batch; alerts validated against the criteria. |
| W5 | ✅ | Server-side running totals (`session`, `boot`, per actor, `estimated`, `reserved`) on every log entry and in `hello`; Deepgram minutes logged as estimated cost (audit H). |

## Phase 3 — console

| Ref | Status | What was done |
|---|---|---|
| R1, R5 | ✅ | External store with `useSyncExternalStore` slices (`web/lib/store.ts`); derived arrays computed in the reducer; memoized panels; `onPlayingTs` only on change; Versions diffs memoized. |
| R2, U5 | ✅ | Timeline at 8 Hz; keyboard listener registered once (ref); arrows only when the track or the body has focus; `role="slider"`; Home/End. |
| R3 | ✅ | Panels stay mounted (`hidden`); hidden panels pause polling; unsaved settings guarded on unload. |
| R4 | ✅ | Transcript lines have server ids (Deepgram) or client ids; typed API client with timeout, abort, `ok` check and error toasts; `try/finally` on busy flags. |
| W6, W12 | ✅ | Review strip follows every seek (debounced) with the query highlighted; "video not in DVR window"; seek queued until `LEVEL_UPDATED`; media-error recovery capped (+ `swapAudioCodec`); Safari `getStartDate()`. |
| W7, feature 1 | ✅ | Viewer sparkline from viewer events; gifts / follows / joins feed with top gifters. |
| U1, U2 | ✅ | Native `<dialog>` confirm / prompt (feedback with verdict + textarea, cancel sends nothing — audit E); undo toasts for highlight delete, clear handled and rule removal (60 s server-side trash); version restore as a new version (audit). |
| W8, G | ✅ | Director URL params are a non-persisted override; LIVE only when the socket and the stream are up; "all clear" replaced by an honest state (last decision age, unavailable sources, paused paid calls); moderation warnings can be hidden for a public overlay (`warnings=0`). |
| W9 | ✅ | One lazy `AudioContext`; distinct chime for warnings. |
| W10, B | ✅ | Highlights kept on reset; end-of-session summary card (duration, flags, chat, speech, peak viewers, spend, top fired, CSV / Markdown export). Source freshness (`available / stale / missing / error`) in every snapshot; jev sees "(silence)" vs "(audio unavailable)"; captions and interim lines expire by age. |
| U3 | ◐ | Buttons for actionable rows, full tab pattern (`aria-controls`, arrow keys), labels on icon buttons, native dialogs, slider semantics, one live region for toasts; lint with `jsx-a11y` rules (oxlint). No axe run. |
| U4 | ✅ | `minmax(0, 1fr)` columns, toast width clamp, single-column layout from 1100 px with the search kept, no horizontal scroll at 375 px (verified). |
| R6 | ✅ | Fonts self-hosted (`@fontsource`); hls.js loaded on demand in its own chunk; main chunk 136 KB (41 KB gzip). |
| W11 | ✅ | Secrets keep their mask until typed; numbers validated before Save; nav synced with `IntersectionObserver`. |
| I | ✅ | Every WS message carries `seq`; `hello` carries the sequence of its snapshot (one atomic ring state); the client buffers messages that raced `hello` and applies only newer ones; protocol version check with a reload banner. |

## Phase 4 — features

| Item | Status | Notes |
|---|---|---|
| Watch this moment | ✅ | On every card and toast (DVR review on a live, seek on a replay). Clip ±30 s to MP4: ✗. |
| Per-user context | ✅ | Click a name: their messages, flags, follower badge, mute their alerts in this console (explicitly not a TikTok action — audit). |
| Keyword / regex rules | ✅ | Local questions evaluated in-process (`WatchQuestion.local`), no GLM, no jev; patterns validated server-side. |
| Rule pause | ✅ | Server skips paused rules. Edit / recompile: ✗ (delete + undo, or add a new rule). Cost hint: per rule kind only. |
| Notifications | ◐ | Browser `Notification` when the tab is hidden; chime per severity. Webhook / Discord: ✗. |
| Chat filters | ✅ | all / flagged / questions + text filter over the live buffer. |
| Why did this fire | ✅ | `evidence` (the projected state jev judged) on every highlight, shown behind `?`; provenance (`sessionId`, `version`, `decision`). |
| Session export | ✅ | Flags CSV (RFC 4180) and Markdown summary from the summary card; log CSV. |
| i18n, light theme, CSS split | ✗ | Not done. |
| Auth token | ✅ | `JEV_TOKEN`; a public overlay still needs a role split (audit) — not done. |

## Audit items not covered

- Public question queue, engagement ledger, usage packs, annotated corpus, three-mode replay (only dry run + real), shared moderation roles, Playwright smoke test, `HttpApi` migration.
- The server still auto-connects at boot when `TIKTOK_USERNAME` is set (unchanged behaviour). The `server-noautostart` launch configuration runs it without that.

## Incident during this work

Running the first version of the test suite polluted the real `runtime/` directory (the modules resolved their paths at import time, before the test set `JEV_RUNTIME_DIR`). Effects, all corrected by hand afterwards: 1,020 test highlights were added to `store.json` and the real **unpinned** highlights of the day were trimmed by the cap (only the pinned scene highlight remains); three test overrides were written to `settings.json` and removed. Paths are now resolved lazily and the tests assert that the real files are untouched. The keys in `runtime/settings.json` were also displayed in the session transcript: rotate them.

## How to verify

```bash
bun run check        # typecheck + lint + tests + build
bun run dev          # then open http://localhost:5173 ; Settings → Replay → dry run to replay for free
```
