# Backend Context

Parent spec: see root CLAUDE.md

## Stack
Node.js 20, TypeScript, Fastify, Redis, viem, node-cron

## Services
order-book-server/    — REST API for orders (Fastify + Redis)
matching-engine/      — price-time priority CLOB matcher
keepers/              — funding accrual cron job

## Do not build
Subgraph, The Graph integration, fee distributor