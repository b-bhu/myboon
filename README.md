# myboon

> **myboon tells you why the market moved and lets you act in the same app.**

Crypto users currently understand the market in one place and act in another.
myboon brings those two parts together: it turns scattered signals into
researched, developing stories, connects each story to the relevant market, and
keeps the resulting positions visible from one mobile experience.

---

## How it works

```
Markets move -> myboon explains why -> you open the relevant market -> myboon tracks what happens next
```

A funding rate spikes on BTC perps. Odds shift in a prediction market. A token
narrative develops across social and news sources. myboon researches the signal,
shows how the story developed, and brings the relevant market into the app.

---

## The app

myboon is built around one loop, not a row of disconnected crypto tools.

| Layer | What happens |
|-------|--------------|
| **Understand** | Follow researched updates, developing stories, and important market dates |
| **Act** | Inspect or act through integrated prediction markets, perps, swaps, and liquidity products |
| **Track** | See wallet balances, open positions, venues, and outcomes together |

The feed explains what matters. Markets brings the next step into the app.
Wallet and position views show what the user owns and what changed.

---

## Current status

myboon is a working beta built by a solo founder. It does not yet have external
users or revenue. The immediate milestone is to distribute the Android beta
through Solana Mobile, onboard the first users, and validate whether this
connected experience reduces confusion and unnecessary app switching.

---

## Architecture

Start with the current [`product vision`](./docs/VISION.md), the
[`documentation index`](./docs/README.md), and the
[`founder application Q&A`](./docs/applications/2026-08-founder-application-qa.md).

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
git clone https://github.com/b-bhu/myboon.git
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

## Planned revenue

myboon is currently pre-revenue.

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
