# tiktok:jev

A live co-pilot for TikTok streamers. It watches a live (chat, gifts, viewers, the host's voice and the video) and
asks [TypeSafe jev](https://docs.typesafe.ai/), a fast "System One" decision model, typed questions about it every
second: *is someone asking the host a question? is the chat turning hostile? is the room hyped? did the host just
promise a giveaway?* What fires becomes a card for the operator (the **console**) and for the host (the **director**,
a second screen or an OBS overlay).

Running in production at **https://code.samlepirate.org** (token required).

```
TikTok live ─► chat · gifts · likes · joins · viewers ─┐
           └─► ffmpeg ─► video (HLS) · frames ─► vision captions ─┤─► 30 s rolling state ─► jev (every tick
                       └─► audio ─► Deepgram transcript ───────────┘      and every chat message)
                                                                              │
             your rules in plain language ─► GLM writes jev questions ────────┤
                                                                              ▼
                                         flags · prompts · meters ─► console + director + OBS overlay
```

## What it does

- **Rules in plain language.** "Tell me when someone asks about the price" → GLM writes 1–5 jev questions (yes/no,
  choice or score) that read only the media you chose (host speech, video, chat). Or a **keyword / regex rule**,
  free and instant, testable on past sessions before you add it.
- **Every second, cheaply.** jev answers all room questions on the last 30 s of the live (~$0.00003 a call); an
  unchanged room reuses the previous answers; every chat message is judged by the per-message questions.
- **Flags with evidence.** Each card keeps what was flagged, the exact state jev judged ("why did this fire"), and its
  provenance. Say it was wrong and GLM rewrites the question; every version of the question set can be diffed and
  restored.
- **Built-in helpers.** Answered prompts close themselves, duplicate questions fold into one card, gifts become
  "thank X" prompts, promises get a due time, a FAQ provides prepared answers, live polls are counted from chat; the
  app also adapts its pace to the room, degrades gracefully before the budget runs out, repairs its media pipeline
  and advises on its own rules.
- **Director for the host.** Stage, focus, dashboard and OBS overlay layouts, keyboard-driven, with timers, a run of
  show, polls and celebrations.
- **Recording and replay.** Every session is recorded (events, and the video as MP4); live DVR review with search
  over chat and speech; replays at wall-clock speed with the video in sync, optionally with zero paid calls.
- **Safety rails.** Session budget with reservation before each call, rate-limit and bad-key circuit breakers,
  bounded chat queue, health bar, token auth, atomic state files.
- **English and French**, per browser.

## Quick start

```bash
bun install                          # Bun 1.3.14, plus ffmpeg on PATH
cp .env.example .env                 # OPENROUTER_API_KEY, DEEPGRAM_API_KEY (optional), TIKTOK_USERNAME (optional)
bun run dev                          # server :3001, console http://localhost:5173
```

Type a live account in the header and **Connect** (or 👁 to connect when it goes live). Press `d` for the director.
Docker: `docker build -f deploy/Dockerfile -t jev . && docker run -p 7777:7777 -e JEV_TOKEN=… -e OPENROUTER_API_KEY=… -v jev-data:/data jev`.

## Documentation

| Document | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Requirements, local install, Docker, troubleshooting |
| [docs/USAGE.md](docs/USAGE.md) | The console, rules, flags, the director, replays, shortcuts |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable, setting, browser preference and director URL parameter |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works: services, media pipeline, decision loops, helpers, cost control, persistence |
| [docs/API.md](docs/API.md) | HTTP routes, auth, WebSocket protocol |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Repository layout, scripts, tests, conventions, how to extend |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Production: GHCR image, `deploy` branch, Portainer, Nginx Proxy Manager |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Future work: director automation (visuals, scenes driven by jev / GLM), and more |
| [AGENTS.md](AGENTS.md) | Short brief for coding agents |
| [docs/history/](docs/history/) | Past audits, the improvement plan and its implementation status |

## Stack

Bun · [Effect](https://effect.website) · React 19 · Vite · ffmpeg · [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector)
· OpenRouter (jev `typesafe/jev-1.13`, GLM `z-ai/glm-5.3-flash`, vision `z-ai/glm-4.6v`) · Deepgram nova-3 ·
hls.js · bun:test, happy-dom, Testing Library, Playwright.
