# syntax=docker/dockerfile:1

# ---- base ----------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=development

# ---- dependencies (full, includes dev tooling) ---------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- compile TypeScript --------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- one-shot verification image: tests + build + HTTP smoke --------------
FROM deps AS verify
# Source is copied so vitest/tsc and the smoke script are available;
# scripts/verify.sh runs the tests and a fresh production build itself.
COPY . .
CMD ["sh", "scripts/verify.sh"]

# ---- production runtime ---------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# Container-level healthcheck as a second layer; compose also defines one.
# Exec form (JSON array) so the '$' in the JS is never shell-expanded.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
