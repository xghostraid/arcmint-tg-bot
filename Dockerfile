# Always-on ArcTrade bot (long-polling Grammy process)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    fonts-dejavu-core fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# tsx is needed to run TypeScript in production without a separate build step
RUN npm install tsx@4.19.4 --no-save

COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets

# SQLite lives on the Railway volume at /data (never bake wallets into the image).
# DATA_DIR must stay /data in Railway env — empty container FS = "lost" wallets.
RUN mkdir -p /data
ENV NODE_ENV=production
ENV DATA_DIR=/data

# Outer shell: if Node ever exits, restart immediately (never stay dead)
# Node itself also loops long-polling restarts in src/index.ts
CMD ["sh", "-c", "while true; do npx tsx src/index.ts; code=$?; echo \"[watchdog] process exited code=$code — restart in 3s\"; sleep 3; done"]
