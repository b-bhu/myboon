#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/myboon}"
BRANCH="${BRANCH:-main}"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Repo not found at $REPO_DIR"
  exit 1
fi

cd "$REPO_DIR"

echo "Fetching latest from $BRANCH..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Building workspace packages..."
pnpm --filter @myboon/shared build
pnpm --filter @myboon/tx-parser build
pnpm --filter @myboon/collectors build

echo "Before reloading PM2, make sure required Supabase migrations are applied:"
echo "  - supabase/migrations/20260706_pipeline_runs.sql"
echo "  - supabase/migrations/20260706_news_source_state.sql"
echo "This repo does not include a Supabase CLI config, so migrations are applied outside this script."

echo "Reloading PM2 processes..."
# Removed by the structured-feed cutover. PM2 does not prune renamed apps from
# its saved process list automatically.
pm2 delete myboon-news-runner 2>/dev/null || true
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "Process status:"
pm2 list
