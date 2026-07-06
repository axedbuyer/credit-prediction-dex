# matching-engine — price-time priority CLOB matcher + on-chain settler.
# Entry point: src/main.ts -> compiled to dist/main.js (npm run build == tsc).
#
# Build context: this directory (backend/matching-engine/). On Railway, set
# "Root Directory" = backend/matching-engine for this service. All contract
# addresses (CLOB_SETTLEMENT_ADDRESS, CREDIT_MARKET_ADDRESS, USDC_ADDRESS,
# YES_TOKEN_ADDRESS, NO_TOKEN_ADDRESS) are supplied via env vars at runtime;
# the contracts/deployments JSON is only a local-dev fallback and is not
# needed inside the image.
#
#   docker build -t matching-engine .
#   docker run --env-file .env matching-engine

FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs appuser \
 && chown -R appuser:nodejs /app
USER appuser

# No HTTP server in this process (poller only) — no EXPOSE, no health check endpoint.
CMD ["node", "dist/main.js"]
