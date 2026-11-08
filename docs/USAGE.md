# Using tiktok:jev

Two screens:

- the **console** (`/`): for the operator (or the streamer before the live). Connect, write rules, review flags,
  replay sessions, tune settings.
- the **director** (`/?view=director`): for the host during the live, on a tablet, a second monitor, or as an OBS
  browser source. Big prompts, room meters, polls, timers.

Both speak English and French (Settings → This browser → Language, remembered per browser).

## 1. A first live in five minutes

1. Open the console and sign in with the `JEV_TOKEN` if asked.
2. Settings (`,`) → API keys: check that OpenRouter (and Deepgram) say **test ✓**.
3. Type the streamer's handle in the header and press **Connect** (the account must be live), or press **👁** to
   watch the account: the server checks every minute and connects when the live starts, and reconnects if it drops.
4. The video plays, chat and host speech scroll, and the six starting rules run: hype, host asks chat, reply
   needed, mood, message safety, asks host.
5. Press `d` to open the director in a new tab; give it to the host.
6. When something fires, a card appears in **Flagged** (and in the director's queue). Mark it handled, pin it, or
   tell jev it was wrong.

## 2. The console

```
┌ header: connection · replay picker · viewers · chat pace · questions vN · spend · director · chime ┐
├ health bar (only when something is wrong: budget, breaker, ffmpeg, speech, backlog, disk…) ─────────┤
├ timeline (live DVR or replay) · review strip ─────────────────────────────────────────────────────────┤
│ left: video · scene caption · host     │ middle: Room gauges · events · poll · Chat     │ right: tabs │
│ transcript                             │ (each message with its per-message answers)    │ 1…8         │
└────────────────────────────────────────┴────────────────────────────────────────────────┴─────────────┘
```

### Header

- **Connect / Disconnect**: a live session. Disconnect also stops the watcher for that live.
- **👁 connect when live**: arms the watcher (see [CONFIGURATION.md](CONFIGURATION.md#tiktok) `autoConnect`, `resume`).
  The pill shows who it waits for and when it looks next.
- **Replay picker**: plays a recording (🎥 = video available).
- Metrics: viewers, chat velocity, question set version and count, jev latency (last 40 ticks), "cached" when the last
  tick reused answers, session spend (with the estimated Deepgram part and the cap), GLM busy/idle.

### Video, timeline, review

- Player: mute (`m`), compact/large (`v`), **REC** (`r`) starts/stops an archive clip when the session did not start
  recording.
- **Live**: the timeline is the session so far (DVR window). Click to review a moment: the video jumps there and the
  review strip shows ±30 s of host speech and chat. **Back to live** (`l`). Older than the DVR window: "video not in
  DVR window" (the archive MP4 still has it).
- **⌘K** searches chat and host speech of the session (live or replay) and jumps to a hit.
- **Replay**: extent, playhead, elapsed / remaining, chat and speech activity, video coverage, flags as they fire.
  Click or ← → (10 s), Home / End. A seek restarts the replay from that point with a clean state (flags stay).

### Room and chat (middle column)

- **Room**: one gauge per window question, its current answer and whether it fires; dashed when jev is unsure;
  "skipped" when its source failed or the rule is paused. **👎** on a gauge: "this answer is wrong", "it should have
  fired and did not" (missed), or "correct (just record it)", with a note; wrong and missed make GLM rewrite it.
- **Events**: gifts, follows, joins, top gifters, viewer sparkline.
- **Poll** (📊): first line the question, then 2–8 options, one per line. jev reads every chat message as a vote
  (first vote per viewer). End keeps the result on screen.
- **Chat**: every message with its per-message answers; filter all / flagged / questions; click a viewer for details
  and to mute their alerts in this console (does nothing on TikTok).

### Tabs (keys `1`–`8`)

1. **Flagged**: every highlight, newest first. Search (`/`). For each card: what was flagged (message, host speech,
   scene, room), the flags with their answers, the **?** "why did this fire" (the exact state jev judged), pin,
   mark handled / reopen, delete (60 s undo), "watch this moment", and **rate**: pick "Wrong: <flag>" or
   "Correct: <flag>" and add a note ("what should jev have answered, and why?"). Correct is only recorded; wrong is
   recorded and GLM rewrites the question with your note.
   Cards closed by helpers say why: answered by the host, thanked, duplicate, expired.
2. **Rules**: the composer and the list (see §3).
3. **Versions**: every question set version with a diff (instructions, criteria, added / removed) and **restore**
   (the old questions become a new version).
4. **GLM**: what the prompt writer did (compile, refine, auto-refine), with token counts.
5. **Log**: every model call and system event with latency, tokens and cost; totals per actor, per hour, since boot;
   filter, errors only, CSV export.
6. **Replays**: every recording with duration, chat and speech counts, clips, size and jev's retention verdict.
   Expand for an activity chart, the first messages and host lines, downloads (MP4, events `.jsonl`), **▶ Replay**,
   **⚙ Simulate live** (the video through the real media pipeline, for development) and delete.
7. **State**: the live snapshot jev reads (transcript, captions, chat, activity, source health).
8. **Settings** (`,`): everything in [CONFIGURATION.md](CONFIGURATION.md), with help on each field, test buttons for
   keys and models, export / import / reset, and per-browser options (language, notifications, sign out).

### Console shortcuts

`1`–`8` panels · `,` settings · `d` director · `/` search flags · `⌘K` search the session · `r` REC · `m` mute ·
`v` player size · `s` chime · `l` back to live · `←` `→` seek · `?` help · `esc` close. Shortcuts never fire while
typing or with ⌘ / Ctrl / Alt held.

## 3. Rules

A rule says what to watch for, in plain language, and which media it reads.

### jev rules (paid, smart)

Type a sentence, tick the sources, **Add**. GLM turns it into 1–5 jev questions (shown under the rule with "fires
when …"). Examples offered in the composer:

- "Tell me when someone in chat asks about price, cost, or how to buy." (chat)
- "Tell me when the host promises to do something later (a giveaway, a follow-up, a link)." (transcript)
- "Flag when nobody is visible on camera or the host has left the frame." (video)
- "Tell me when chat is asking things the host is not addressing at all." (chat + transcript)

Sources matter: jev sees only those media, and questions with different sources run as separate calls. A rule about
single chat messages becomes a **message** question (one call per message); a rule about the room, the host, the
video or trends becomes a **window** question (every tick).

Write rules in any language: questions are written in English for jev, labels in the language of your rule.

### Keyword rules (free, exact)

Choose **keyword**, give a regex (JavaScript syntax, flags such as `i`), a label and sources. Evaluated in-process on
each message (or the window), no model call. Presets: links, phone numbers, price words. **▶ Test on** runs the
pattern on the current session or any recording and shows how many messages match, with a sample, before you add it.

### Managing rules

- **✎ Edit** in place: a jev rule is recompiled (its question ids are reused where possible, so flags keep their
  provenance); a keyword rule keeps its question id.
- **Pause**: the server skips its questions (no call, no alert); **Remove** with 60 s undo.
- **Rule hygiene** (every 10 min): a chip per rule with jev's advice (keep / refine / pause / remove) and the reason;
  **Apply** does it.
- Feedback from the Flagged tab rewrites questions; the Versions tab undoes any change.

## 4. The director (host screen)

Open with `d` from the console or `/?view=director`. Four layouts, keys `1`–`4`:

- **Stage**: room meters with trend sparklines, then the prompt queue (reply to a viewer, a moderation warning,
  something you said, the camera).
- **Focus**: one prompt at teleprompter size, the rest as "up next".
- **Dashboard**: viewers (trend, peak), chat pace, likes, diamonds and top gifters, follows, on-air clock, every rule
  with its current answer, trend and "fired ×N", chat rules with matched / judged and the last flagged message,
  the queue and the gift / follow / join feed.
- **Overlay**: for OBS, only what viewers may see: the featured prompt as a lower third and the chat ticker.

Cards: `↓` `↑` (or `j` `k`) select, `↵` / `x` done, `f` feature (pin), `z` snooze for a few minutes. Prompts expire
after the card lifetime (45 s default) unless pinned.

Extras: countdown `t` (`5`, `2:30`, `45s`; chimes at zero), run of show `n` (checklist written in the settings;
promises jev caught appear there), poll `p`, meters `m`, chat `c`, sound `s`, keep screen awake `w`, full screen
`⇧F`, settings `g`, help `?`, `esc` leaves an overlay chosen on screen. Gift and follow celebrations, a recap at the
end of the live. With interruptibility on, plain chimes wait for a pause in the host's speech (≤ 1 min); warnings
always ring.

**OBS browser source**:

```
https://<host>/?view=director&layout=overlay&transparent=1&warnings=0&token=<JEV_TOKEN>
```

URL parameters never save; see [CONFIGURATION.md §4](CONFIGURATION.md#4-director-url-parameters).

## 5. Recordings and replays

Every session (live or simulated) writes `recordings/<user>-<time>.jsonl` (all events) and `.meta.json`; with
`media.recordVideo` (or REC) also `.mp4` clips (stream copy, finalized into seekable files when stopped; recovered at
boot after a crash).

- **Replay**: events at wall-clock speed, video in sync, timeline with seek. Rules run again (paid) unless
  **Settings → Replay → Dry run** is on. Use it to try new rules on a past live.
- **Simulate live**: the recording's video through ffmpeg as if it were live (HLS, DVR, REC, search work), for
  development without a stream.
- At the end of a live the console shows a **session summary** (duration, flags, warnings, spend, peak viewers, most
  fired questions).

## 6. Money and safety rails

- **Session budget** (`budget.sessionUsd`, $2): reserved before every paid call; at the cap jev / vision / GLM stop,
  recording continues, the health bar says so. Helpers have their own budget (`assist.sessionUsd`, $0.50).
- **Budget degradation**: an alert at 80 %, then jev chooses to pause vision, then chat judging, keeping the room
  rules to the end.
- **Unchanged room = free tick**: the previous answers are reused when nothing meaningful changed.
- **Chat floods**: a bounded queue, an age cutoff and a per-minute budget; dropped messages are counted, never billed
  late; keyword rules still run.
- **Bad key / no credit**: paid calls pause 5 min (breaker), fix the key in Settings.
- **Health bar**: everything that is not normal (ffmpeg, speech, stalled ticks, backlog, disk, finalizing, regime,
  repairs jev applied or suggests).
