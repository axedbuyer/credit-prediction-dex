# order-book-server — Fastify REST API + Redis (ioredis) order book.
# Entry point: src/main.ts -> compiled to dist/main.js (npm run build == tsc).
#
# Build context: this directory (backend/order-book-server/). On Railway, set
# "Root Directory" = backend/order-book-server for this service — no files outside
# this directory are required (main.ts falls back to a hardcoded USDC address and
# placeholder token/CLOB addresses, and wraps its optional
# contracts/deployments/base-sepolia.json read in try/catch, returning {} on any
# failure — see docs/deploy-testnet.md "Known gotchas"). Set CREDIT_MARKET_ADDRESS
# etc. via Railway env vars instead of relying on that file.
#
# Build & run (verified locally with `npm ci && npm run build`; image itself was NOT
# docker-built in this environment — no docker binary available):
#   docker build -t order-book-server .
#   docker run --env-file .env -p 3001:3001 order-book-server

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

EXPOSE 3001
CMD ["node", "dist/main.js"]
