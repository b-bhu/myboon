# Repository map

Work from the monorepo root. The commands below are existing package scripts, invoked with pnpm filters; choose focused checks for the code you changed. CI's required checks are listed in [CI](ci.md).

| Area | What it does | Useful existing scripts |
| --- | --- | --- |
| `apps/hybrid-expo` | Expo / React Native app for mobile and web. | `pnpm --filter hybrid-expo lint`; `pnpm --filter hybrid-expo test` |
| `apps/web` | Next.js web app. | `pnpm --filter @myboon/web build` |
| `apps/video` | Remotion compositions for demos and submissions. | `pnpm --filter @myboon/video build`; `pnpm --filter @myboon/video final-submission:render` |
| `packages/api` | Hono API for feed, markets, wallet/action data and backend provider integrations, including Helius. | `pnpm --filter @myboon/api test:internal`; `pnpm --filter @myboon/api smoke` |
| `packages/shared` | Shared SDKs, clients and types used across packages/apps. | `pnpm --filter @myboon/shared build`; `pnpm --filter @myboon/shared test` |
| `packages/collectors` | Source collectors and research, entity, editor and publisher pipelines. | `pnpm --filter @myboon/collectors build`; `pnpm --filter @myboon/collectors test:entity-manager` |
| `packages/tx-parser` | Solana transaction parsing and stream processing. | `pnpm --filter @myboon/tx-parser build`; `pnpm --filter @myboon/tx-parser test` |
| `supabase/migrations` | Ordered SQL migrations for the Supabase/Postgres schema and policies. | No package script is defined here; migrations need `needs-bucket` review. |
| `infra` | VPS deployment and systemd setup files. | No package script is defined here. VPS runtime checks and deploys go through `/home/box/bin/vps`; see [security](security.md). |
| `scripts` | Repository helper scripts, including the API free-port runner. | No package script is defined for this directory. |

Only run scripts listed in the relevant `package.json`. Do not treat a package's `dev`, `start`, or deployment script as a local verification command without the required authorization and environment.
