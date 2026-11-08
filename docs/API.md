# HTTP and WebSocket API

Everything the console and the director do goes through this API (`server/http.ts`), so a script can do it too.
Types are in `shared/protocol.ts`. JSON everywhere; errors are `{ "ok": false, "error": "…", "code"?: "…" }` with a
4xx/5xx status; bodies are validated (Effect Schema) and an invalid one answers `400 invalid body: …`.

## Authentication

When `JEV_TOKEN` is empty every route is open (keep the server on loopback). When it is set, `/api/*` (except the
three auth routes), `/ws`, `/hls/*` and `/recordings/*` need one of:

| Credential | Use |
|---|---|
| `Authorization: Bearer <JEV_TOKEN>` | Scripts. |
| Cookie `jev_session` (HttpOnly, SameSite=Strict, 30 days, `Secure` over HTTPS) | Browsers, obtained with `/api/auth/login`. It is a hash of the token, never the token. |
| `?token=<JEV_TOKEN>` | OBS sources and media URLs that cannot send headers. |

A cookie-authenticated write (non-GET) from another origin is refused (`403 csrf`). Failed authentications are
limited to 10 per 15 min per address (`429` + `Retry-After`); the API allows 600 requests / min per address. With
`TRUST_PROXY=true` the address is the first `X-Forwarded-For`.

| Route | Body | Answer |
|---|---|---|
| `GET /api/auth` | | `{ ok, required, authenticated }` |
| `POST /api/auth/login` | `{ token }` | `{ ok, required }` + `Set-Cookie` (401 on a wrong token) |
| `POST /api/auth/logout` | | clears the cookie |

```bash
H="Authorization: Bearer $JEV_TOKEN"; B=https://code.samlepirate.org
curl -s -H "$H" $B/api/health
```

## State

| Route | Answer |
|---|---|
| `GET /api/state` | The same `hello` message a WebSocket client receives (everything needed to render). |
| `GET /api/health` | `{ ok, health: HealthInfo, status: StreamStatusEvent, totals: CostTotals, uptimeSec }` |

## Session

| Route | Body | Notes |
|---|---|---|
| `POST /api/connect` | `{ username? }` | Live session (username defaults to `tiktok.username`). Waits up to 90 s for "live". `409` on failure (`@x is not live`, …). Arms the watcher when `tiktok.resume` is on. |
| `POST /api/connect` | `{ replay: "<id>", offsetMs?, simulate? }` | Replay a recording (from `offsetMs`), or `simulate: true` to push its video through the media pipeline as if live. Disarms the watcher. |
| `POST /api/disconnect` | | Ends the session and disarms the watcher. |
| `POST /api/replay/seek` | `{ offsetMs }` | Replays only. |
| `GET /api/watch` | | `WatchState` |
| `POST /api/watch` | `{ armed, username? }` | Arm / disarm the "connect when live" watcher. |
| `POST /api/record/start`, `/api/record/stop` | | Archive clip on demand (live / simulate). |

## Session index (live or replay)

| Route | Query | Answer |
|---|---|---|
| `GET /api/search` | `q`, `kinds=chat,transcript` | `SearchHit[]` |
| `GET /api/context` | `ts`, `span` (ms, ≤ 300 000) | `MomentContext` (transcript, chat, captions around `ts`) |
| `GET /api/timeline` | | `SessionTimeline` for a live session (buckets, video segments, DVR start), `null` otherwise |

## Rules and questions

| Route | Body | Notes |
|---|---|---|
| `POST /api/rules` | `{ text, sources?, kind?: "jev" }` | GLM compiles the rule (can take up to ~90 s). `422` with GLM's error on failure. |
| `POST /api/rules` | `{ text, kind: "keyword", pattern, flags?, label?, scope?, sources? }` | Local regex rule. |
| `POST /api/rules/test` | `{ pattern, flags?, scope?, recording? }` | `PatternTest`: matches on the current session, a recording, or the latest one. |
| `PATCH /api/rules/:id` | `{ paused }` and/or `{ text?, sources?, pattern?, flags?, label? }` | Pause / resume; edit (a jev rule is recompiled). |
| `DELETE /api/rules/:id` | | `{ ok, undoMs: 60000 }` |
| `POST /api/rules/:id/restore` | | Within the undo window. |
| `POST /api/versions/:v/restore` | | The questions of version `v` become a new version. |
| `POST /api/feedback` | `FeedbackRequest` `{ questionId, verdict: wrong\|missed\|correct, answer, stateExcerpt, expected?, note?, highlightId?, rewrite? }` | Records the verdict; wrong / missed make GLM rewrite the question unless `rewrite: false`. |

Sources are `transcript`, `video`, `chat`; regex flags match `^[gimsuy]{0,6}$`.

## Highlights (flags)

| Route | Body |
|---|---|
| `PATCH /api/highlights/:id` | `{ pinned?, resolved? }` |
| `DELETE /api/highlights/:id` | (60 s undo) |
| `POST /api/highlights/:id/restore` | |
| `POST /api/highlights/clear` | `{ mode: "resolved" \| "all" }` |

## Polls

| Route | Body |
|---|---|
| `POST /api/poll` | `{ question, options: [2..8 distinct] }` |
| `POST /api/poll/end` | |
| `DELETE /api/poll` | |

## Settings

| Route | Body | Notes |
|---|---|---|
| `GET /api/settings` | | `PublicSettings` (secrets masked, `secrets` booleans, `reconnectFields`). |
| `PATCH` or `PUT /api/settings` | `{ section: { key: value } }` | Any subset; see [CONFIGURATION.md](CONFIGURATION.md#2-runtime-settings). Saving `keys.openrouter` or `budget` resets the breaker; toggling `tiktok.autoConnect` arms / disarms the watcher. |
| `POST /api/settings/reset` | | Back to the environment values. |
| `POST /api/settings/test` | `{ which: "openrouter" \| "deepgram" \| "models", value? }` | `{ ok, ms, detail, models? }` |

```bash
curl -s -X PATCH -H "$H" -H 'content-type: application/json' \
  -d '{"budget":{"sessionUsd":5},"media":{"dvrMinutes":120}}' $B/api/settings
```

## Recordings and media

| Route | Notes |
|---|---|
| `GET /api/recordings` | `RecordingInfo[]`, newest first. |
| `GET /api/recordings/:id/peek` | `RecordingPeek` (first chat, transcript, captions, activity per minute). |
| `DELETE /api/recordings/:id` | Not the current session or the one being replayed (`409`). |
| `GET /recordings/<id>.mp4`, `/recordings/<id>.jsonl` | Downloads; `Range` requests supported (video seeking). |
| `GET /hls/live.m3u8`, `/hls/seg_*.ts` | Live HLS (playlist `no-store`, segments immutable). |

Anything else is the console from `dist/` (unknown paths serve `index.html`, so `/?view=director` works).

## WebSocket `/ws`

Connect (same auth: cookie or `?token=`), then only receive; the server ignores client messages.

1. The first message is `hello` with a `seq`: the full state (status, questions, history, rules, recent events,
   decisions, message decisions, GLM activity, highlights, log, settings, video, recording, replay, totals, health,
   summary, sessionId, watch, poll, assist, `protocol`).
2. Every later message is a delta with an increasing `seq`. A client must buffer messages received before `hello`
   and apply only those with `seq > hello.seq`, dropping duplicates (what `web/lib/store.ts` does).

| `type` | Payload |
|---|---|
| `event` | `event: LiveEvent` (chat, gift, like, member, social, viewers, transcript, caption, stream) |
| `snapshot` | `snapshot: Snapshot` (every tick) |
| `decision` / `messageDecision` | a window tick's / a message's answers, fired, skipped, cached, partial, cost |
| `questions` | `set`, `history`, `rules` after any change |
| `highlight` | `highlight`, `fresh` (true = new, ring and notify) |
| `highlightRemoved` | `id`, `undoMs` |
| `glm` | `activity: GlmActivity` (compile / refine / auto-refine, running → done / error) |
| `log` | `entry: LogEntry`, `totals: CostTotals` |
| `settings` | `settings: PublicSettings` |
| `video` | `video: VideoSource \| null` (HLS live or recorded segments) |
| `recording` | `recording: RecordingState` |
| `replay` | `replay: ReplayInfo \| null` |
| `health` | `health: HealthInfo` |
| `session` | `sessionId` |
| `watch` | `watch: WatchState` |
| `poll` | `poll: PollState \| null` |
| `assist` | `assist: AssistState` (regime, degrade, interruptible, repair, rule advice, helper spend) |
| `reset` | `reason`, `summary`: the session ended (or a replay seek): drop live data, keep highlights |

`PROTOCOL_VERSION` is 2; the console offers a reload when `hello.protocol` differs from its own.

## jev request shape (for reference)

What the server sends to OpenRouter for one group of questions:

```json
POST https://openrouter.ai/api/alpha/decisions
{ "model": "typesafe/jev-1.13",
  "state": { "host_speech_last_30s": "…", "chat_recent": [ … ], "activity": { … } },
  "questions": {
    "mood": { "type": "choice", "instructions": "What is the dominant mood…?",
              "criteria": { "fun": "…", "focused": "…", "tense": "…", "bored": "…" } } } }
→ { "model": "…", "answers": { "mood": { "type": "choice", "choice": "fun", "probabilities": { … }, "confidence": 0.82 } },
    "usage": { "input_tokens": 410, "output_tokens": 3, "cost": 0.00003 } }
```
