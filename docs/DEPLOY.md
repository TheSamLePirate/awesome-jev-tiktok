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
2. **Make the package public**: GitHub → Packages → `awesome-jev-tiktok` → Package settings → Change
   visibility → Public (the server pulls without credentials). Or keep it private and add a GHCR registry with a
   `read:packages` token in Portainer.
3. **Portainer**: Stacks → Add stack → *Repository*
   - URL `https://github.com/TheSamLePirate/awesome-jev-tiktok`, reference `refs/heads/deploy`, compose path `compose.yml`
   - *GitOps updates* / automatic updates on, polling (e.g. 2 min)
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
- Healthcheck: `GET /api/auth`.

## Rolling back

Revert the last commit on `deploy` (or commit a compose.yml naming an older tag): Portainer redeploys it at its
next poll.

## Locally

```sh
docker build -f deploy/Dockerfile -t jev .
docker run --rm -p 7777:7777 -e JEV_TOKEN=dev -e OPENROUTER_API_KEY=... -v jev-data:/data jev
```
