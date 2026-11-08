# awesome-jev on the dedicated server (docs/DEPLOY.md): the Bun server serves the built console, the API,
# the WebSocket and the media on port 7777; Nginx Proxy Manager terminates TLS in front of it.
# Built by .github/workflows/deploy.yml.

# 1. the console: vite needs the dev dependencies
FROM oven/bun:1.3 AS web
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY shared/ shared/
COPY web/ web/
RUN bun run build

# 2. the server: production dependencies, ffmpeg (HLS, frames, audio), the build
FROM oven/bun:1.3 AS app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY shared/ shared/
COPY server/ server/
COPY --from=web /app/dist dist/
ARG BUILD_SHA=dev
# (state and recordings on the /data volume; the token is mandatory: the console can rewrite API keys)
ENV NODE_ENV=production PORT=7777 HOST=0.0.0.0 TRUST_PROXY=true JEV_REQUIRE_TOKEN=true \
    JEV_RUNTIME_DIR=/data/runtime JEV_RECORDINGS_DIR=/data/recordings BUILD_SHA=$BUILD_SHA
RUN mkdir -p /data/runtime /data/recordings
VOLUME /data
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:7777/api/auth').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["bun", "server/index.ts"]
