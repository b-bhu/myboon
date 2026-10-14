# Pull request CI

`.github/workflows/ci.yml` runs on every pull request. It has two Ubuntu jobs:

1. **secrets:** checks out full history (`fetch-depth: 0`) and runs `gitleaks/gitleaks-action@v2` with the GitHub token.
2. **checks:** checks out the repository, sets up pnpm and Node.js 22 with pnpm caching, then runs `pnpm install --frozen-lockfile` followed by the four commands below.

The package test and lint scripts can be reproduced from the repository root:

```bash
pnpm --filter hybrid-expo lint
pnpm --filter hybrid-expo test
pnpm --filter @myboon/shared test
pnpm --filter @myboon/tx-parser test
```

Install dependencies first with the same frozen-lockfile command used in CI:

```bash
pnpm install --frozen-lockfile
```

The root `test` script is a placeholder and CI deliberately does not run it. No package currently defines a typecheck script. Gitleaks is run through its GitHub Action; the repository has no package script for reproducing that action locally. CI's PR workflow is authoritative for the secrets check.
