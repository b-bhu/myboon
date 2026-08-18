# myboon

> **A context-to-action app for crypto markets.**

myboon turns scattered crypto signals into remembered context, then connects
that context to integrated market actions. Understand what moved, open the
relevant market, and track what happens next from one mobile experience.

---

## How it works

```
Markets move -> myboon explains the context -> you open the relevant market -> positions track what happens next
```

A whale drops $500K on a Polymarket bet. Funding rate spikes on BTC perps.
Odds shift on an EPL match. myboon catches the signal, explains the context,
and brings the relevant market into the app.

---

## The app

myboon is built around one loop, not a row of disconnected crypto tools.

| Layer | What happens |
|-------|--------------|
| **Context** | Understand the live narratives, signals, and entities moving markets |
| **Markets** | Inspect or act through integrated prediction markets, perps, and future swap routes |
| **Positions** | Track balances, venues, outcomes, and what happened after the action |

Context explains what matters. Markets brings the next step into the app.
Positions show what you own and what changed.

---

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full system design.

---

## Packages

```
apps/
  hybrid-expo/    Mobile app (Expo / React Native)
  web/            Landing page (Next.js 15)

packages/
  api/            API server (Hono) — Feed, markets, wallet/action data
  collectors/     Feed V3 source pipelines — Data Engineer, Researcher, Editor, Publisher
  shared/         Shared SDK — PolymarketClient, PacificClient, types
  tx-parser/      Solana transaction parsing
  entity-memory/  Entity store (pre-persistence)
```

---

## Getting started

### Prerequisites

- Node.js 18+
- pnpm

### Install

```bash
git clone https://github.com/bucketshop69/myboon.git
cd myboon
pnpm install
```

### Run the API

```bash
cp packages/api/.env.example packages/api/.env
# fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
pnpm --filter @myboon/api start
```

### Run the mobile app

```bash
cd apps/hybrid-expo
pnpm start
```

### Run the Polymarket collector + researcher

```bash
cp packages/collectors/.env.example packages/collectors/.env
pnpm --dir packages/collectors polymarket:markets-data-engineer
pnpm --dir packages/collectors polymarket:researcher
```

For VPS process mode, set `POLYMARKET_MARKETS_RUN_ONCE=0` for the collector,
then start:

```bash
pm2 start ecosystem.config.cjs
```

This production cut intentionally runs only:

```text
Polymarket data collector -> local pipeline.sqlite candidates
Polymarket researcher     -> local pipeline.sqlite research
```

Temporary pipeline rows stay on the VPS. Only durable entity and publishing
records are written to Supabase.

---

## Revenue

- **Prediction market actions** — Polymarket builder affiliate %
- **Perps / swap routes** — fee share
- **Context API / intelligence** — x402 micropayments *(post-MVP)*

---

## Infrastructure

- **Runtime:** Node.js / TypeScript (ESM)
- **Database:** Supabase (Postgres)
- **LLM:** configurable CLI-agent runners for feed research/editor/publisher
- **Mobile:** Expo (React Native)
- **Monorepo:** pnpm workspaces
- **VPS:** API + feed collectors on US VPS

---

<p align="center">
  <sub>Built on Solana</sub>
</p>
