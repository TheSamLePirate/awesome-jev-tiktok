# Deployment — the dedicated server (code.samlepirate.org)

The whole app (Bun server: console, API, WebSocket, HLS, recordings) runs in one container on port 7777;
Nginx Proxy Manager serves it as https://code.samlepirate.org. Nothing calls into the server: Portainer
polls the `deploy` branch, as for black-hole-gpu.

```
push main ─► ci.yml "check" (types, lint, tests, build)
          ─► ci.yml "server": deploy/Dockerfile → ghcr.io/thesamlepirate/awesome-jev-tiktok:<sha⁷>-<run>.<attempt>
          ─► a commit on `deploy`: compose.yml naming that tag
Portainer (stack "jev", from the `deploy` branch, polling) ─► pulls the tag ─► recreates the container
```

## One-time setup

1. **First run of the workflow** (push to main, or Actions → ci → Re-run): it creates the GHCR package and the
   `deploy` branch.
2. **The package is public** (`ghcr.io/thesamlepirate/awesome-jev-tiktok`, inherits the public repository): the
   server pulls without credentials. The very first push to a new package can answer `denied` once; re-run the job.
3. **Portainer** (done 2026-11-08: stack `jev`, id 120, created through the API — `POST /api/stacks?type=2&method=repository&endpointId=2`
   with `ComposeFile`, `Env`, `AutoUpdate.Interval: "1m"`): Stacks → Add stack → *Repository*
   - URL `https://github.com/TheSamLePirate/awesome-jev-tiktok`, reference `refs/heads/deploy`, compose path `compose.yml`
   - automatic updates on, polling every minute
   - Environment variables: `JEV_TOKEN` (required: `openssl rand -hex 24`), `OPENROUTER_API_KEY`,
     `DEEPGRAM_API_KEY`, optionally `TIKTOK_USERNAME`, `TIKTOK_SESSION_ID`
4. **Nginx Proxy Manager**: proxy host `code.samlepirate.org` → `http://<host>:7777`, **Websockets Support on**
   (the console's `/ws`), SSL with Let's Encrypt, Force SSL. Proxy buffering can stay on; HLS segments are small.

## In the container

- `PORT=7777`, `HOST=0.0.0.0`, `TRUST_PROXY=true` (rate limits per visitor from `X-Forwarded-For`),
  `JEV_REQUIRE_TOKEN=true` (no token: the server exits rather than run an open console).
- State (`store.json`, settings, watcher) in `/data/runtime`, recordings in `/data/recordings`: the `jev-data`
  volume, kept across redeploys. Retention deletes expendable recordings below the disk floor.
- ffmpeg/ffprobe from Debian. The login cookie is `Secure` because NPM sends `X-Forwarded-Proto: https`.
- Healthcheck: `GET /api/auth`. Bun 1.3.14 (same as CI).

## Current production

| | |
|---|---|
| URL | https://code.samlepirate.org (Nginx Proxy Manager → host port 7777, WebSockets on) |
| Portainer | https://portainer.samlepirate.org, endpoint 2, stack `jev` (id 120), polls `deploy` every minute |
| Container | `jev_jev_1`, volume `jev-data` |
| Image | `ghcr.io/thesamlepirate/awesome-jev-tiktok:<sha⁷>-<run>.<attempt>` (also `:latest`) |
| Secrets | In the stack's environment only. The console token is also kept by the operator outside the repository. |

Checks: `curl -s https://code.samlepirate.org/api/auth` (`required: true`), the container's health in Portainer,
its logs (`awesome-jev server on http://0.0.0.0:7777 … · token auth on`).

Changing a secret: edit the stack's environment variables in Portainer and *Update the stack* (or through the API:
`PUT /api/stacks/120?endpointId=2` with `Env` and `RepositoryReferenceName`). The server reads them at boot.

## Rolling back

Revert the last commit on `deploy` (or commit a compose.yml naming an older tag): Portainer redeploys it at its
next poll.

## Locally

```sh
docker build -f deploy/Dockerfile -t jev .
docker run --rm -p 7777:7777 -e JEV_TOKEN=dev -e OPENROUTER_API_KEY=... -v jev-data:/data jev
```
