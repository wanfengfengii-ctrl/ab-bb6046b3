# syntax=docker/dockerfile:1

# ---- base ----------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

# ---- build: full toolchain (used for tests and the verify job) -----------
FROM base AS build
ENV NODE_ENV=development
RUN npm ci
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY test ./test
RUN npm run build

# ---- production: minimal runtime image for the API -----------------------
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
# The server has zero runtime dependencies; only compiled JS is needed.
COPY package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=12 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/server.js"]

# ---- verify: one-shot job that runs tests, build and HTTP smoke checks ---
FROM build AS verify
COPY scripts ./scripts
# API_URL is supplied by docker compose (http://api:8080). The container exits
# non-zero if any step fails.
CMD ["sh", "-c", "npm test && npm run build && node scripts/smoke.mjs"]
