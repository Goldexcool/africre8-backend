# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ARG TARGETARCH
WORKDIR /app
# ffmpeg + yt-dlp are used by the verification worker to sample video frames
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -fsSL -o /usr/local/bin/yt-dlp \
     "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$([ "$TARGETARCH" = arm64 ] && echo _aarch64)" \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json /app/prisma.config.ts ./
EXPOSE 3000
# Default = API. Worker overrides the command with: node dist/worker.js
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
