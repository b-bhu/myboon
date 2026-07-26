# myboon — Session Memory

## Session Start Checklist

1. Read `docs/ARCHITECTURE.md` — full product + system context
2. Read `docs/HANDOFF.md` — what was done last session, what's next
3. `git status` — check for anything pending

## Project

Narrative intelligence engine. Monorepo at `/home/main-user/.openclaw/workspace/myboon`

## Stack

- Runtime: Node.js / TypeScript (ESM), pnpm workspaces
- DB: Supabase (Postgres)
- LLM: MiniMax M2.5 (Anthropic-compatible API)
- Mobile: Expo (planned)
- Collectors run on: US VPS (Polymarket geo-restricted)
- Brain agents run on: local dev

## Packages

- `packages/tx-parser` — Solana tx parsing
- `packages/brain` — LLM agents (analyst, classifier, research)
- `packages/collectors` — data ingestion (Polymarket live, X/Kalshi planned)
- `packages/entity-memory` — in-memory entity store (pre-persistence)

## Credentials

All in `.env` files (gitignored). Never in code.

- `packages/collectors/.env` — SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
- `packages/brain/.env` — SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MINIMAX_API_KEY
- Values stored in external MEMORY.md (Claude auto-memory)

## Workflow

- Discuss + plan → write PRD to `docs/PRDs/` → open issue on GitHub → coder subagent → reviewer subagent → commit + push
- Reviewer runs before EVERY commit — no exceptions
- Reviewer checks: no secrets, no .env staged, code matches task

## Key Docs

- `docs/ARCHITECTURE.md` — source of truth for product direction
- `docs/HANDOFF.md` — latest session summary + next steps
- `docs/PRDs/` — durable PRDs, kept in-repo for context
- Issues live in GitHub (`bucketshop69/myboon`), never as files in the repo
