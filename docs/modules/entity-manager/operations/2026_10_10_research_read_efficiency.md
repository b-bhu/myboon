# Research read efficiency — bounded beta changes

Implementation checkpoint: 10 October 2026. This records a small application change, not proof of sustained Supabase or pipeline recovery.

## What changes

- Legacy history selects its existing ID/title/summary/date fields plus four JSON-valued source-URL projections. It no longer downloads the entire `context` JSON. URL precedence, whitespace/type handling and older duplicate filters remain unchanged; complete stored article captures are untouched.
- Healthy Research storage probes default to five minutes instead of thirty seconds. Startup checks run immediately; an observed failure closes admission and retries after thirty seconds. Existing outage backoff still grows to five minutes, and repeated invalidation cannot shorten an established outage deadline. Both readers are still checked.
- A process-local recent-history cache is owned by one Research runner, shared across that runner's article readers, and limited to a 60-second TTL, 128 entries/outstanding loads and 1 MiB of serialized retained content. It coalesces concurrent reads, returns separate copies to separate articles, and retains each article's own memoized snapshot. Cache age starts when the lookup starts. Expired, oversized, failed or incompletely covered results cannot become cache hits. This is a serialized-content bound, not a precise JavaScript heap limit.

Cache admission requires the trusted adapter's combined legacy/private coverage capability, a supported article response (`articleItems`, `candidateTruncated: false`), an active selected identity, and successful legacy and managed reads. The adapter advertises its capability only after reading a supported deployed response; old/unsupported shapes retain their uncached compatibility path. A context/probe failure clears shared entries; older in-flight results cannot repopulate the cache. Graceful stop clears it after active work drains; close also clears it.

## Freshness and preserved behavior

The cache applies only to selected entities' latest-five story context. Research can see a recent history snapshot up to sixty seconds old; an article continues using its own consistent snapshot while it finishes. Catalogue/identity searches, targeted older duplicates, paid decisions, reservations and Entity Manager's final context/revision validation are not cached. Entity Manager still performs fresh authoritative reads before saving. The cache does not replace identity/reference validation or uncertain-outcome recovery.

Removing the extra recent-history REST read was **deferred**. SQL and REST choose different rows at a five-item boundary when more than five items share a date. The implementation keeps the existing two-reader merge, origin/ID deduplication, date fallback, deterministic tie behavior and five-item bound. Successful merged snapshots are then reused across articles. No new SQL migration is needed.

Only two optional settings are introduced:

| Setting | Default | Accepted values |
| --- | --- | --- |
| `FEED_V3_RESEARCH_CONTEXT_HEALTHY_PROBE_INTERVAL_MS` | `300000` | integers `30000`–`300000` |
| `FEED_V3_RESEARCH_HISTORY_CACHE_TTL_MS` | `60000` | integers `0`–`60000`; `0` disables shared caching |

## Verification performed

The final single run passed **80/80** checks across the nine focused files below, with zero failures/skips. Tests use fake provider/read ports and disposable SQLite files, with no paid calls or production mutations. Whitespace validation passed.

```bash
pnpm exec tsx --test \
  packages/collectors/src/research-gate/supabase-reader.test.ts \
  packages/collectors/src/research-gate/article-history-cache.test.ts \
  packages/collectors/src/research-gate/managed-context-reader.test.ts \
  packages/collectors/src/research-engine/context-availability.test.ts \
  packages/collectors/src/research-engine/run-shared-research.test.ts \
  packages/collectors/src/research-engine/article-placement.test.ts \
  packages/collectors/src/entity-manager/article-persistence.test.ts \
  packages/collectors/src/research-engine/v4-runner-composition.test.ts \
  packages/collectors/src/entity-manager/postgres-knowledge-writer.test.ts
```

Covered: URL projection semantics/filters, healthy cadence versus outage backoff, coalescing/expiry/byte and work bounds, invalidation across in-flight reads, independent cache instances and source lanes, unsupported/incomplete deployed coverage, transient failures across participating articles, lazy selected-history loading, per-article consistency, older duplicate independence, mixed-origin/date-tie five-item boundaries, existing placement/persistence safeguards and runner composition.

The first expanded run exposed a fixture-isolation failure: an older composition test read the actual owner-drained runtime control and consequently did no work. Its two offline live-runtime fixtures now inject the existing in-memory control, leaving production controls and runtime behavior unchanged. Execution/source-ownership assertions remain intact.

One bounded live REST projection check at **10 October, 20:32 IST / 15:02 UTC** returned **HTTP 200** in **1,052 ms**, one row and **645 JSON bytes**. All four URL aliases were present and full `context` was absent. No source values or credentials were printed. This validates query compatibility, not sustained database availability or workload savings.

No typecheck, full-repository suite, database migration/restart/resize, queue replay/deletion, provider/model change or process restart was performed. The six non-API services remain owner-stopped; `myboon-api` is excluded from process actions. Loading this code into stopped workers requires a separately authorized restart.

## Deferred and still unverified

Actual cache hit rate, byte/request reductions and sustained accepted-item throughput need a later authorized workload. The new healthy cadence lowers only the theoretical healthy-probe maximum from 5,760 to 576 remote calls/day; it does not establish measured savings or the prior outage cause. The Supabase compute tier and failure-window resource pressure still need dashboard confirmation.

Defer shared/distributed caches, broad catalogue caching, per-entity batch history, lightweight SQL probes, candidate-only SQL responses, lock/query redesign and downstream integrations. These beta changes reduce avoidable work while preserving recovery and persistence contracts; they do not erase genuine failures or uncertain paid outcomes.
