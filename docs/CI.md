# CI

Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

## Which package jobs run on a PR

A PR runs lint/test/typecheck only for the packages it changes, plus packages that depend on them. Path detection is `dorny/paths-filter@v3` in the `detect` job (full git history); each package job decides its own `if:`.

| Job | Runs when the PR touches |
| --- | --- |
| hybrid-expo | `apps/hybrid-expo/**` or `packages/shared/**` |
| shared | `packages/shared/**` |
| tx-parser | `packages/tx-parser/**` |
| contracts | `packages/contracts/**` |
| analyst | `packages/analyst/**`, `packages/shared/**`, or `packages/contracts/**` |
| scout-news | `packages/scout-news/**`, `packages/shared/**`, or `packages/contracts/**` |
| api | `packages/api/**`, `packages/shared/**`, or `packages/collectors/**` |

Changing only docs or `apps/web` runs no package jobs — `ci-ok` still passes. `packages/collectors` has no standalone CI job today; it turns on the `api` job.

## Full runs

Every package job runs (all seven, plus the always-on jobs) when a PR touches any of:

- `pnpm-lock.yaml`
- root `package.json` (exact path, not subpackages)
- `tsconfig.base.json`
- `.github/workflows/**`
- `packages/atlas-schema/**`
- `supabase/migrations/**`

Any push to `main` is always a full run.

## Always on

- `secrets` (gitleaks) and `migrations-lint` (squawk) run on every PR and every push to `main`, regardless of paths.
- `ci-ok` is the single stable pull-request check: it is green when every job that actually ran succeeded, and red on any failure. Skipped jobs (paths not touched) do not block it. If `detect` itself fails, everything downstream skips and `ci-ok` goes red.

Each package job installs dependencies, runs `pnpm exec tsx scripts/check-ecosystem.ts`, then only the commands that package needs (analyst and scout-news additionally get a postgres:17 service and their test env URLs). The old single serial `checks` job is gone so one package's failure can no longer hide a later one.

## Forcing a full run

The filter is purely path-based, so an empty commit does not help. Edit any file under one of the full paths — a comment or whitespace-only change is enough, e.g. add a comment line to `.github/workflows/ci.yml`.
