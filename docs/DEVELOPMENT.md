# Development

## Repository layout

```
server/            Bun + Effect server (one file per service, see ARCHITECTURE.md §3.1)
  tests/           bun:test suites: unit, services, session, http, assist
shared/protocol.ts Types shared by server and web (+ PROTOCOL_VERSION)
web/               React 19 console and director (Vite root)
  App.tsx          console          Director.tsx   host screen
  components/      console panels   director/      director model, views, widgets
  lib/             store, api, hotkeys, prefs, audio, notify, format
  i18n/            en / fr helpers (strings live next to each component in `M = { en, fr }`)
  tests/           bun:test + happy-dom + Testing Library (setup.ts, fixtures.ts)
e2e/               Playwright: real server on :3999 with an isolated runtime and a synthetic recording
deploy/            Dockerfile, compose template, render-compose.sh (see DEPLOY.md)
docs/              this documentation; docs/history/ = past audits and plans
runtime/           state (git-ignored)      recordings/   sessions (git-ignored)
```

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Server with `--watch` on :3001 + Vite on :5173. |
| `bun run start` | Server only (serves `dist/`). |
| `bun run build` | Vite build into `dist/` (hls.js and React in their own chunks). |
| `bun run typecheck` | `tsc --noEmit` over shared, server, web, e2e. |
| `bun run lint` | oxlint (`.oxlintrc.json`). |
| `bun run test` | Server tests, then web unit tests. |
| `bun run test:web:cov` | Web tests with coverage. `bunfig.toml` requires **100 % of lines** (99 % functions). |
| `bun run check` | typecheck + lint + test + build: what CI runs. |
| `bun run e2e` | Playwright (builds, then a real server on :3999 from `e2e/.tmp`). `E2E_SKIP_LIVE=1` skips the live-stream spec; `E2E_LIVE=<user>` picks the account; the live session is capped at $0.50. |

`.claude/launch.json` has three launch configurations (server, server without autostart, web).

## Tests: rules that keep them reliable

- **Server tests** point `JEV_RUNTIME_DIR` / `JEV_RECORDINGS_DIR` at a temp directory and stub jev, GLM and TikTok
  (`LiveProbe` is a tag for that). Never touch the real `runtime/`.
- **Web tests run in one process**, file order depends on the file system (CI's ext4 differs from macOS). A test must
  not depend on what another file left behind:
  - `mock.module(...)` is global for the rest of the run: a file that needs a module behaving a certain way mocks it
    itself (see `app.test.tsx` mocking `hls.js` as unsupported, `videopane.test.tsx` as supported).
  - Module-level singletons need a reset helper (`resetAudioForTests`, `resetSocketForTests`), and shared fakes
    (`FakeAudioContext.instances`, `FakeWS.instances`) must be cleared before asserting on "the last one".
  - Reproduce CI's order locally: run the suite in a Linux container from a copy (not a bind mount):
    `docker run --rm -v "$PWD":/src:ro oven/bun:1.3.14 sh -c 'cp -r /src /app && cd /app && rm -rf node_modules && bun install --frozen-lockfile && bun run test'`
- **Coverage**: new web code needs tests that execute every line, or the run fails.
- **Bun version**: 1.3.14 everywhere (CI, Docker, local). Bun 1.4 changes test behaviour; upgrade deliberately.

## Conventions

- Server code is Effect: services with `Effect.Service`, typed errors (`Data.TaggedError`), `Schema` for every
  external input (HTTP bodies, model outputs, files on disk). Loops catch their causes and log, never crash the
  session.
- Paid calls only through `Gate` (`admit`, `fetchWithTimeout`, `settle`); log every call with `bus.log` including
  tokens, latency, cost and `costKind`.
- Shared types first: change `shared/protocol.ts`, then the server, then the web reducer. Bump `PROTOCOL_VERSION` when
  a message shape changes incompatibly.
- UI strings: add both `en` and `fr` to the component's `M` table.
- Hotkeys: through `useHotkeys`, so the help sheet stays complete.
- Commit messages: a plain sentence describing the change (see `git log`).

## Adding things

- **A setting**: add it to `Settings` in `shared/protocol.ts`, its default in `defaultsFrom` and its clamp in
  `applyPatch` (`server/settings.ts`), the field (label, help, type, range) in `web/components/Settings.tsx` (both
  languages), document it in [CONFIGURATION.md](CONFIGURATION.md). Add it to `RECONNECT_FIELDS` if it only applies at
  connect.
- **An API route**: in `server/http.ts` with a `Schema` body, return `{ ok: true, … }` or `fail(...)`; a client method
  in `web/lib/api.ts`; a test in `server/tests/http.test.ts`; a line in [API.md](API.md).
- **A WebSocket message**: add it to `ServerMessageBody`, publish with `bus.publish`, handle it in the reducer
  (`web/lib/store.ts`), include its state in `hello` if a late client needs it.
- **A helper**: a function in `server/assist.ts` using `ask(...)` (assist budget, dry-run aware), wired in the
  subscription or a `loop(...)`; a settings toggle in `assist`.
- **A seed rule**: `server/seed.ts` (only used when `runtime/store.json` does not exist).

## CI and deployment

`.github/workflows/ci.yml`: `check` (Bun 1.3.14, ffmpeg, install, typecheck, lint, tests, build) on every push and pull
request; on `main`, `server` builds `deploy/Dockerfile`, pushes it to GHCR and updates the `deploy` branch that
Portainer polls. Details in [DEPLOY.md](DEPLOY.md).
