# Roadmap: future improvements

Nothing in this file is built yet. It describes where the app can go, in enough detail that a human or an LLM can
pick a phase and implement it inside the existing architecture ([ARCHITECTURE.md](ARCHITECTURE.md)).

The main track is **director automation**: jev and GLM put things on the host's screen and the OBS overlay, and change
the scene, according to what the host says and what the chat asks. Section 9 lists smaller improvements.

---

## 1. Director automation: the idea

Today the director shows the cards jev flagged, meters, polls and timers. Next, it becomes a **live presentation
surface** that reacts to the conversation:

- The host says *"look at the Andromeda galaxy"* → an image of the Andromeda galaxy appears on stage (and in the OBS
  overlay if allowed), with a caption and its source.
- A viewer asks *"show the numbers for last month"* → a data card with the figures from a configured source.
- The host says *"let's look at their website"* → an iframe of the site (if the domain is allowed).
- *"Make a countdown to 9 pm"*, *"show a chart of the votes"* → a small HTML + JS widget, generated and sandboxed.
- The host starts coding, or opens Q&A, or announces the giveaway → the director (and OBS) switches to the matching
  **scene preset**: layout, visuals, overlay elements, chimes.

The same visuals and scenes are also reachable by hand: buttons, hotkeys, a Stream Deck, the API. Automation only
suggests or applies what a human could have clicked.

### Design principles

1. **jev decides, GLM writes, the server fetches.** jev (cheap, every final utterance and chat message) answers *"is
   there a display request, and of which kind?"*. GLM (rare, more expensive) only runs when a request was detected, to
   extract *what* to show and to write content (a query, a data mapping, a widget). The server does the fetching with
   allowlisted providers. No model ever gets network access.
2. **Three autonomy levels per trigger**: `off`, `suggest` (a card in the director / console: "Show image: Andromeda
   galaxy? ✓ ✕", one key to accept), `auto` (applied at once, with an undo). Default `suggest`.
3. **Viewers see only what is allowed.** Every visual has a target: `host` (director only) or `air` (overlay too).
   Anything generated or fetched from the open web goes to `host` first unless the trigger says otherwise.
4. **Safe by construction.** Generated HTML runs in a sandboxed iframe without network; images and iframes come from
   allowlisted providers and domains; text from chat is data, never instructions (as GLM prompts are today).
5. **Budgeted and logged** like every paid call: through `Gate`, its own budget (`stage.sessionUsd`), every action in
   the log with its trigger and evidence ("why is this on screen").

---

## 2. Concepts and data model

New shared types in `shared/protocol.ts` (sketch):

```ts
/** Something that can be put on screen. */
export type Visual =
  | { kind: "image"; url: string; alt: string; credit?: string; sourceUrl?: string }
  | { kind: "iframe"; url: string; title: string }                       // domain must be allowlisted
  | { kind: "data"; title: string; items: { label: string; value: string; delta?: string }[]; chart?: "bar" | "line" | "none"; source?: string }
  | { kind: "widget"; title: string; html: string }                      // srcdoc, sandboxed, no network
  | { kind: "text"; title?: string; body: string }                       // a big quote, an answer, a link to say aloud
  | { kind: "video"; url: string; title: string };                       // allowlisted (YouTube embed, mp4)

export interface VisualItem {
  id: string; createdAt: number;
  visual: Visual;
  target: "host" | "air";                  // director only, or overlay too
  zone?: "main" | "side" | "lower-third" | "corner" | "fullscreen";
  ttlSec?: number;                         // auto-hide; pinned when absent
  origin: { by: "user" | "jev" | "rule" | "schedule"; triggerId?: string; evidence?: unknown; prompt?: string };
}

/** A director preset: layout + what is visible + overlay options. */
export interface Scene {
  id: string; name: string; icon?: string; hotkey?: string;
  layout: "stage" | "focus" | "dashboard" | "overlay" | "custom";
  zones?: Record<string, { visualId?: string; widget?: "queue" | "meters" | "chat" | "poll" | "timer" | "notes" | "clock" }>;
  overlay?: { show: ("lowerThird" | "ticker" | "poll" | "visual")[]; transparent?: boolean };
  obsScene?: string;                       // optional OBS scene to switch to (phase 6)
}

/** When to act, and how much autonomy. */
export interface StageTrigger {
  id: string; label: string; enabled: boolean;
  when:
    | { kind: "keyword"; pattern: string; flags?: string; on: ("transcript" | "chat")[] }
    | { kind: "intent"; intents: StageIntent[]; on: ("transcript" | "chat")[]; minConfidence: number }
    | { kind: "scene-match"; sceneId: string; description: string }      // "the host is coding", "Q&A time"
    | { kind: "schedule"; at: string } | { kind: "run-of-show"; item: string };
  then: { kind: "show"; visual?: Visual; generate?: StageIntent } | { kind: "scene"; sceneId: string } | { kind: "hide"; zone?: string };
  autonomy: "off" | "suggest" | "auto";
  target: "host" | "air";
  cooldownSec: number;                     // no repeat inside this window
}

export type StageIntent = "image" | "data" | "website" | "widget" | "answer" | "none";

/** What the director renders; published on every change. */
export interface StageState {
  sceneId: string | null; locked: boolean;             // locked = automation may not switch scene
  items: VisualItem[]; suggestions: (VisualItem | { sceneId: string; reason: string; id: string })[];
  spent: number;
}
```

New WebSocket message `{ type: "stage"; stage: StageState }`, included in `hello`. Persisted library (scenes,
triggers, saved visuals) in `runtime/stage.json` through the same atomic writer as `store.json`.

---

## 3. The pipeline

```
final transcript line / chat message
        │
        ▼
 keyword triggers (regex, free) ─────────────────────────────┐
        │                                                     │
        ▼                                                     │
 jev: display intent?  (1 call, batched with existing         │
      helpers when possible)                                  │
   noul  "is the speaker asking to show something on screen?" │
   choice intent: image | data | website | widget | answer | none
   choice scene: <scene ids with their descriptions> | keep   │
        │ confidence ≥ minConfidence, cooldown ok             │
        ▼                                                     ▼
 GLM: resolve (only now)                              action builder
   in:  the utterance (quoted data), recent context, intent   │
   out: { query, entity, mapping, html?, title, alt }  ──────►│
        │                                                     ▼
 server providers (allowlisted, cached)              StageController (server/stage.ts)
   image: Wikimedia Commons / Wikipedia REST / NASA   ├─ autonomy: suggest → suggestion card
   data:  configured JSON / CSV / Google Sheet / API  ├─ auto → apply, undo 60 s
   site:  allowlisted domains → iframe URL            ├─ target host / air
   widget: GLM HTML → sanitized srcdoc                └─ log + bus.publish({type:"stage"})
                                                               │
                                                               ▼
                                          Director (stage zones) · Overlay (air items only) · Console (Stage tab)
```

### 3.1 Intent detection (jev)

- Runs on each **final** transcript line (debounced like the current speech helpers, ~3 s instead of 12 s) and on
  chat messages that already passed the per-message rules (only those flagged as "asks the host" or "request", so the
  flood is not billed twice).
- One jev call carries: `noul display_request`, `choice intent`, and, when scenes have descriptions, `choice scene`
  (scene ids as criteria keys, descriptions as criteria) — the jev way: closed questions, calibrated probabilities.
- State: `{ utterance, speaker: host|viewer, current_scene, recent_visuals (titles), host_speech_last_30s }`.
- Cost: ~$0.00003 per call; at one call every few seconds of speech, well under $0.10/h.

### 3.2 Resolution (GLM)

A new `Glm.resolveVisual(intent, utterance, context)` with a schema-validated output, for example:

```json
{ "intent": "image", "entity": "Andromeda Galaxy", "query": "Andromeda Galaxy M31", "title": "Andromeda (M31)",
  "alt": "Spiral galaxy M31 seen in visible light", "confidence": "high" }
```

For `data`: `{ source: "<configured source id>", select: "<field path or SQL-like filter>", title, items mapping }` — GLM
never invents numbers: it can only pick from configured sources; the server reads the values.

For `widget`: `{ title, html }`, a single self-contained HTML+JS document (no external scripts, no fetch), max ~20 KB.

Cost: ~$0.001 per resolution; only after a detected request.

### 3.3 Providers (server, `server/providers/*.ts`)

| Provider | Source | Notes |
|---|---|---|
| `image.wikimedia` | Wikipedia REST `page/summary` (thumbnail) then Commons search | Free, licensed, credit and source URL kept. Default. |
| `image.nasa` | images-api.nasa.gov | Space topics. |
| `image.search` (optional) | Bing / Brave / SerpAPI image search with SafeSearch strict | Needs a key; `host` target by default. |
| `image.generate` (optional) | An OpenRouter image model | For illustrations; marked "generated". |
| `data.json` / `data.csv` / `data.sheet` | URLs or Google Sheets configured in Settings → Stage → Data sources | Cached 60 s; numbers come from here only. |
| `site` | Allowlisted domains (Settings) | Iframe; many sites forbid framing (`X-Frame-Options`): fallback to a screenshot provider or a link card. |
| `video` | YouTube embed URLs, allowlisted MP4 | Muted by default. |

Every fetched asset is cached under `runtime/stage-cache/` and served by the server (`/stage/<hash>`), so the overlay
never hotlinks and the same visual shows instantly the second time.

### 3.4 Safety

- Widgets: `<iframe sandbox="allow-scripts" srcdoc=…>` with a CSP meta (`default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:`), no `allow-same-origin`, size-limited, killed after N seconds of 100 % CPU
  (heartbeat).
- Images from search providers and anything requested by a **viewer** default to `host` + `suggest`.
- A moderation check (jev `choice safe | unsafe` on the title/alt, plus the provider's SafeSearch) before `air`.
- Domain allowlist for iframes and videos; no user-typed URLs on air without approval.
- A global **kill switch** (key `0` in the director, button in the console): clears the stage and pauses automation.
- Rate limits: one auto visual per 20 s, one scene switch per 60 s (hysteresis), per-trigger cooldown.

---

## 4. Scenes and presets

A **scene** is a saved director configuration: layout, zones, which widgets show, overlay options, optional OBS scene.

Built-in presets to start with:

| Scene | Layout | Typical trigger |
|---|---|---|
| Talk | stage, meters + queue + chat | default |
| Q&A | focus on the prompt queue, questions only, chat ticker on air | "let's do Q&A", many questions in chat |
| Show & tell | main zone = current visual, side = queue | a visual was shown |
| Data | dashboard + data cards | "the numbers", data intent |
| Code / screen | corner cam, minimal overlay, chat side | jev scene-match "the host is coding / sharing a screen" (vision captions) |
| Giveaway | big countdown, poll, gifters | "giveaway", run of show item |
| Break / BRB | full-screen card, music note, timer | "short break", host off camera for 60 s (vision) |
| Outro | recap: top questions, gifters, next live | "thanks for watching", end of stream |

Switching:

- **By hand**: scene bar in the director (buttons with icons), hotkeys (`F1`–`F8` or a chosen key), console Stage tab,
  `POST /api/stage/scene`, Stream Deck / Companion through the HTTP API (bearer token).
- **Classic automation** (no model): run-of-show items with a scene, schedule times, keyword triggers, events
  (stream started → Talk; poll started → Giveaway; stream ending → Outro).
- **jev automation**: the `choice scene` question in the intent call, plus a periodic `scene-match` (every 30 s, with
  vision captions) for silent changes ("the host left the frame" → BRB). Applied only above `minConfidence`, after a
  minimum dwell time in the current scene, and never while the scene is **locked** by the host.

---

## 5. UI

- **Director**: new zones that render `VisualItem`s (image with credit, iframe, data card with optional chart, widget
  iframe, text). A suggestion tray: `y` accept, `n` dismiss, `↵` accept the first. Scene bar. Kill switch `0`. Lock
  scene `L`.
- **Overlay**: renders only `target: "air"` items, with enter/exit animations; a lower-third variant for text and
  data.
- **Console → new "Stage" tab**: library of scenes (editor with a live preview), saved visuals (upload an image, add a
  URL, paste HTML), data sources, triggers (keyword / intent / schedule, autonomy, target, cooldown), the log of
  what was shown and why, and a "try it" box (type a sentence → see the intent, the resolution and the visual it would
  produce, without putting it on screen).
- **Rules tab**: a rule can get a "then show …" action, so existing rules can drive the stage.

## 6. API (sketch)

| Route | Body |
|---|---|
| `GET /api/stage` | `StageState` + library |
| `POST /api/stage/show` | `{ visual \| visualId \| prompt, target, zone, ttlSec }` (`prompt` runs the GLM resolution) |
| `POST /api/stage/hide` | `{ itemId? \| zone? }` |
| `POST /api/stage/scene` | `{ sceneId, lock? }` |
| `POST /api/stage/suggestions/:id` | `{ accept: boolean }` |
| `POST /api/stage/kill` | clears the stage, pauses automation |
| `PUT /api/stage/library` | scenes, triggers, visuals, data sources |
| `POST /api/stage/try` | `{ text }` → intent, resolution, visual preview (no display) |

New settings section `stage`: `enabled`, `sessionUsd`, `defaultAutonomy`, `defaultTarget`, `minConfidence`,
`visualCooldownSec`, `sceneDwellSec`, `imageProviders`, `allowedDomains`, `dataSources`, `widgets` (on/off).

## 7. Implementation plan

| Phase | Content | Models | Size |
|---|---|---|---|
| **S1 · Manual stage** | `StageState`, `server/stage.ts` controller, `stage` WS message, director zones and overlay rendering, scene presets and scene bar, saved visuals library (upload / URL / text), API, console Stage tab (library), kill switch. | none | M |
| **S2 · Classic automation** | Keyword triggers on transcript and chat, run-of-show and schedule triggers, event triggers, cooldowns, suggest / auto, undo, log. | none | S |
| **S3 · jev intent** | Intent call (display request, intent, scene choice) on speech and selected chat; suggestions tray; dwell time and lock; `stage.sessionUsd` budget via `Gate`. | jev | S |
| **S4 · Resolution and providers** | `Glm.resolveVisual`, Wikimedia / NASA image providers, asset cache and `/stage/*`, data sources (JSON, CSV, Sheets) and data cards, allowlisted iframes, moderation before `air`, "try it" box. | GLM | M |
| **S5 · Generated widgets** | GLM HTML+JS widgets in a sandboxed srcdoc iframe (countdowns, charts of poll results, comparisons, simple quizzes), size and CPU limits, saved to the library when the host likes one. | GLM | M |
| **S6 · OBS and hardware** | obs-websocket client (switch OBS scenes and sources with the director scene), Stream Deck / Bitfocus Companion profile on the HTTP API. | none | S |
| **S7 · Learning** | Accepted / dismissed suggestions as feedback (like flag verdicts): per-trigger stats, GLM rewrites the intent questions, trigger hygiene advice. | jev, GLM | S |

Tests per phase follow the current rules: server tests with stubbed jev / GLM / providers, web unit tests at 100 %
lines, an e2e scenario on a synthetic recording ("say Andromeda" → suggestion → accept → image in the overlay).

## 8. Open questions

- Image licensing on air: Wikimedia (licensed, credited) by default; web image search only for the host screen?
- Viewer requests: should a viewer be able to put something on air at all (moderated queue, followers only, gifts)?
- Per-scene budgets, or one stage budget?
- Where the stage runs when several directors are open: one shared state (today's model) is simplest.
- Iframes that refuse framing: screenshot service (cost, latency) or a link card?

---

## 9. Other improvements

From the earlier audits ([history/](history/)) and the current state:

- **Clips**: export ±30 s around a flag to MP4 (`ffmpeg -ss/-to` on the archive), share links.
- **Notifications out**: webhooks, Discord / Telegram for warnings and flags when nobody watches the console.
- **Roles**: a read-only overlay token and a moderator role, distinct from the admin `JEV_TOKEN` (the overlay URL
  should not carry the admin secret).
- **Multi-stream**: several sessions at once (one `Session` per account), a stream picker in the console.
- **Moderation actions**: delete / mute on TikTok from a warning card, if the connector and the account allow it.
- **Reference corpus for jev**: replay labelled recordings to measure each rule's precision / recall before changing
  it; regression check on every GLM rewrite.
- **Light theme**, CSS split per component, an axe accessibility run in CI.
- **Bandwidth**: one FLV pull feeding both the live pipeline and the archive (today two pulls while recording).
- **SLOs and metrics**: Prometheus endpoint (tick latency, drops, spend), alerts.
- **Mobile director**: a compact phone layout and PWA install for the host.
- **Other platforms**: YouTube Live, Twitch chat and HLS as alternative sources behind the same `LiveEvent` stream.
