# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Only copy package files first — maximises layer cache
COPY package*.json ./
RUN npm ci --ignore-scripts

# ── Stage 2: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Compile TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ── Stage 3: Development (hot-reload via volume mount) ────────────────────────
FROM node:20-alpine AS development
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# ── Stage 4: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser  -u 1001 -S appuser -G appgroup

WORKDIR /app

# Only copy what's needed for production runtime
COPY --from=builder --chown=appuser:appgroup /app/dist        ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Keys directory (mounted as secret in K8s)
RUN mkdir -p /app/keys && chown appuser:appgroup /app/keys

USER appuser

EXPOSE 3000

# Healthcheck for Docker/K8s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/v1/search?limit=1 | grep -q '"success"' || exit 1

CMD ["node", "dist/main"]
