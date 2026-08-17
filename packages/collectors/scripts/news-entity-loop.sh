#!/usr/bin/env bash
set -euo pipefail

INTERVAL_SECONDS="${NEWS_ENTITY_LOOP_INTERVAL_SECONDS:-7200}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTORS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_DIR="${NEWS_ENTITY_LOOP_LOCK_DIR:-$COLLECTORS_DIR/.data/news-entity-loop.lock}"

run_once() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "news entity loop already running; skipping this tick" >&2
    return 0
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' RETURN

  NEWS_FEED_RUN_ONCE=1 pnpm --dir "$COLLECTORS_DIR" news:feed:ingest
  pnpm --dir "$COLLECTORS_DIR" news:research
  pnpm --dir "$COLLECTORS_DIR" entity-manager:news
}

if [[ "${1:-}" == "--once" ]]; then
  run_once
  exit 0
fi

while true; do
  run_once
  sleep "$INTERVAL_SECONDS"
done
