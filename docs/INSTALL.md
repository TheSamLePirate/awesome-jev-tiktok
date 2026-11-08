# Installation

Two ways to run tiktok:jev: on your machine (development, or a laptop next to the stream) or as a Docker container on
a server (the production setup at https://code.samlepirate.org, see [DEPLOY.md](DEPLOY.md)).

## 1. What you need

| Requirement | Why |
|---|---|
| [Bun](https://bun.sh) **1.3.14** (CI and the image are pinned to it) | Runs the server, the tests and the build. |
| `ffmpeg` and `ffprobe` on `PATH` | Video (HLS), frames for vision, audio for Deepgram, recordings. |
| An [OpenRouter](https://openrouter.ai) API key with credit | jev decisions, GLM (question writer), vision captions. |
| A [Deepgram](https://deepgram.com) API key (optional) | Live transcription of the host. Without it the app runs on chat and video only. |
| A TikTok account to watch | Any public live; no TikTok login needed. |

Typical spend with the defaults: a few cents to ~$1 per hour of live, capped by `budget.sessionUsd` ($2 per session)
plus `assist.sessionUsd` ($0.50) for the helpers. Deepgram is billed separately (≈ $0.55/h, multilingual).

## 2. Local install

```bash
git clone https://github.com/TheSamLePirate/awesome-jev-tiktok.git
cd awesome-jev-tiktok
bun install
cp .env.example .env      # then edit it
```

Minimal `.env`:

```dotenv
OPENROUTER_API_KEY=sk-or-...
DEEPGRAM_API_KEY=...          # optional
TIKTOK_USERNAME=              # optional: set it and the server watches this account from boot
```

Every variable is described in [CONFIGURATION.md](CONFIGURATION.md#1-environment-variables).

### Development (hot reload)

```bash
bun run dev
```

- Server on http://127.0.0.1:3001 (`bun --watch server/index.ts`).
- Console on http://localhost:5173 (Vite; proxies `/api`, `/hls`, `/recordings`, `/ws` to :3001).
- Director: http://localhost:5173/?view=director

### Production build on one port

```bash
bun run build     # web → dist/
bun run start     # server on :3001 serves dist/, the API, /ws and the media
```

Open http://127.0.0.1:3001.

### Use it from another device (tablet, second PC)

The server binds loopback by default because the console can read and change API keys. To expose it on your network:

```dotenv
HOST=0.0.0.0
JEV_TOKEN=<a long random secret>     # openssl rand -hex 24
```

The console then asks for the token once and keeps a 30-day HttpOnly cookie. Behind a reverse proxy add
`TRUST_PROXY=true`.

### Check that it works

```bash
curl -s http://127.0.0.1:3001/api/health | head -c 400
```

In the console: Settings → API keys → **test** next to each key, and **check model ids**. Then type a username in the
header and **Connect** (the account must be live), or pick a recording in the replay picker.

No live at hand? Replays: every connected session is recorded under `recordings/`; the Replays tab lists them.
`Settings → Replay → Dry run` replays with zero paid calls.

## 3. Docker

The image (`deploy/Dockerfile`) contains Bun 1.3.14, ffmpeg, the production dependencies and the built console. It
listens on **7777**, requires `JEV_TOKEN`, trusts `X-Forwarded-For`, and keeps everything in the `/data` volume.

```bash
docker build -f deploy/Dockerfile -t jev .
docker run -d --name jev -p 7777:7777 \
  -e JEV_TOKEN=$(openssl rand -hex 24) \
  -e OPENROUTER_API_KEY=sk-or-... -e DEEPGRAM_API_KEY=... -e TIKTOK_USERNAME=someone \
  -v jev-data:/data jev
```

Or the published image: `ghcr.io/thesamlepirate/awesome-jev-tiktok:latest` (public). Put TLS in front of it (the
login cookie is `Secure` when the proxy sends `X-Forwarded-Proto: https`) and enable WebSocket support on the proxy.

The production server, its CI and Portainer stack are described in [DEPLOY.md](DEPLOY.md).

## 4. Updating

- Local: `git pull && bun install`, restart. Settings, rules and recordings stay in `runtime/` and `recordings/`.
- Server: push to `main`; CI builds a new image and Portainer redeploys within a minute ([DEPLOY.md](DEPLOY.md)).

The console detects a server with a newer protocol and offers a reload.

## 5. Troubleshooting

| Symptom | Where to look / what to do |
|---|---|
| "server unreachable" banner | Server not running, or wrong port; `curl /api/health`. |
| Sign-in loops | `JEV_TOKEN` changed: sign in again. Behind a proxy without HTTPS the cookie is not `Secure`; that is fine. |
| `@user is not live` on Connect | The account is not streaming. Arm the watcher (👁) to connect when it starts. |
| No video, chat works | ffmpeg missing (`ffmpeg -version`), or TikTok gave no FLV URL (log: "running chat-only"). |
| "speech off: Deepgram gave up" | Wrong Deepgram key: fix it in Settings, then reconnect. |
| "paid calls paused: OpenRouter rejected the API key (401)" / "no credit (402)" | Fix the key or the balance; saving the key closes the breaker. |
| "budget reached" | Raise `budget.sessionUsd` (Settings → Budget). |
| "rate limited · retry in N s" | OpenRouter 429; it resumes on its own. |
| Store reset after a crash | A corrupt `runtime/store.json` is moved to `store.corrupt-<time>.json` and the backup is loaded. |
| Disk filling up | Recordings: delete in the Replays tab, lower `media.dvrMinutes`, turn `media.recordVideo` off, or turn the retention helper on. |
