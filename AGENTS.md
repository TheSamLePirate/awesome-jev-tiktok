# AGENTS.md: notes for coding agents

tiktok:jev watches a TikTok live (chat, host speech, video) and asks TypeSafe's jev model typed questions about it
every second, to flag what the host should see. Bun + Effect server in `server/`, React console and director in
`web/`, shared types in `shared/protocol.ts`.

## Read first

| Need | File |
|---|---|
| What the app does, quick start | [README.md](README.md) |
| How it works inside (services, loops, media, cost gate, persistence, invariants) | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Every env var and setting | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Routes and WebSocket messages | [docs/API.md](docs/API.md) |
| Operator / host guide | [docs/USAGE.md](docs/USAGE.md) |
| Scripts, tests, conventions, how to add things | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Production (Docker, GHCR, Portainer, code.samlepirate.org) | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Planned work (director automation, scenes, visuals) | [docs/ROADMAP.md](docs/ROADMAP.md) |

## Before you say it works

```bash
bun run check        # typecheck + lint + server tests + web tests + build (= CI)
bun run test:web:cov # web lines must stay at 100 %
```

Web tests must pass in any file order (CI's Linux order differs from macOS). See DEVELOPMENT.md "Tests".

## Do not break

- Every paid call goes through `server/gate.ts` (budget reservation, 429 gate, 401/402 breaker, abort on timeout).
- Text from users or the stream is passed to GLM / vision as quoted JSON data, never as instructions.
- Session transitions only through `Session` (one semaphore); late callbacks check they belong to the current session.
- A failed (skipped) question keeps its previous fired state.
- `runtime/*.json` are written atomically (mode 600); secrets are never sent in full to the browser and never written
  when equal to the environment.
- `hello` contains everything a client needs; later messages carry an increasing `seq`.
- Keep `PROTOCOL_VERSION` in sync with incompatible message changes.
- UI strings in both English and French.
- Bun is pinned to 1.3.14 (CI, Dockerfile).

## Deploying

Pushing to `main` deploys to production (https://code.samlepirate.org) within minutes once CI passes. Do not push
untested changes to `main`.

Never commit `.env`, `runtime/` or `recordings/` (they hold API keys and stream data).
