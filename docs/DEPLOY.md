# VPS Deploy — myboon

## Processes managed by PM2

| Name | Package | Schedule |
|------|---------|---------|
| `myboon-api` | `packages/api` | persistent HTTP server (port 3000) |
| `myboon-polymarket-data-engineer` | `packages/collectors` | Polymarket markets Data Engineer |
| `myboon-news-feed-ingestor` | `packages/collectors` | Structured article/social collection every 10 minutes |
| `myboon-feed-v3-research` | `packages/collectors` | Shared News + Polymarket Research worker |
| `myboon-feed-v3-entity-manager` | `packages/collectors` | Shared ResearchPacket to Entity Memory worker |
| `myboon-hermes-orphan-sweeper` | `packages/collectors` | Reaps aged, unowned Hermes/browser process groups |
| `myboon-editor-draft` | `packages/collectors` | Entity Memory to Editor Draft |
| `myboon-publisher` | `packages/collectors` | Generic Editor Draft Publisher |

PM2 is the source of truth for VPS runtime. `infra/vps/systemd/*` is deprecated and should not be installed for the current Feed pipeline.

Note: `packages/collectors/src/polymarket/run-editor.ts` and `run-publisher.ts`
(the research-row editor/publisher lane) are intentionally NOT in PM2. The
production path is researcher → entity-manager → editor-draft → publisher.

---

## Hermes CLI prerequisite

The shared Research worker, shared Entity worker, and editor-draft can shell
out to the `hermes` CLI. The two scouts do not use Hermes. Before starting PM2
the box needs:

```bash
# hermes installed, on PATH, and authenticated
hermes --version

# one-shot structured mode (gate, extractor, editor-draft)
hermes --ignore-rules -z 'Return exactly this JSON: {"ok": true}'

# chat/tool mode with page reading (news research AND the research engine)
hermes chat --profile myboonfeed --toolsets browser --quiet \
  --query 'Open https://example.com and return its <title> as JSON: {"title": "..."}'

# pinned agent-browser HTTP-only reader used by the news fast path
pnpm --filter @myboon/collectors exec agent-browser --version
pnpm --filter @myboon/collectors exec agent-browser --json --content-boundaries \
  --max-output 2000 read https://example.com
```

Existing isolated Hermes profiles may be retained for rollback to an earlier
release, but Phase 1 does not register the four source-specific workers that
used them. Do not delete or repair profile data during this cutover.

```bash
hermes profile create mybooneditor --clone-from default
```

Provider/model routing for the shared workers is owned by the inference gateway
configuration. Do not add source-specific Hermes wrappers back to the PM2
ecosystem.

If the structured Hermes smoke fails, keep shared Research and Entity safe-off
and repair provider authentication before activation. Phase 1 has no
source-specific or last30days fallback. Agent-browser is used only by bounded
code-owned retrieval paths; do not enable browser/deep research as an implicit
fallback. Version 0.34.0 requires Node.js 24 or newer.

Known news article URLs are first retrieved by a public-only HTTP client that
validates every redirect before requesting it and pins the validated DNS address
through connection. The retrieved bytes are then exposed on a random, one-use
loopback URL for pinned `agent-browser`'s HTTP-only `read` command; agent-browser
never receives the external URL. A successful conversion must report
`lifecycle.launched=false`; its bounded content is treated as untrusted evidence
and passed to structured Hermes. Invalid, private, short, timed-out, or
incompletely vetted destinations fail closed in Phase 1; they do not trigger a
source-specific browser or `web` fallback.

All programmatic Hermes calls go through `HermesService`. Browser chat and
structured one-shot work have independent cross-process budgets, controlled by
`HERMES_BROWSER_MAX_CONCURRENCY` and `HERMES_STRUCTURED_MAX_CONCURRENCY`, so a
long browser queue cannot starve entity/editor calls. Chat calls are tagged
`--source tool`; the service captures Hermes' exact `session_id` and deletes
that session after the call. On timeout it signals the complete Unix process
group, keeps the concurrency lease through the SIGKILL grace period, and confirms
group exit so browser descendants do not survive as orphan Chrome processes.
Interactive Hermes sessions are not selected or pruned by this lifecycle.
`myboon-hermes-orphan-sweeper` is a second line of defense: every five minutes
it gracefully closes browser sessions and reaps only process groups older than
15 minutes with no live pipeline owner. It skips browser cleanup whenever a
legitimate research call is active, and escalates survivors to `SIGKILL`.

If a machine was interrupted before exact cleanup completed, inspect only the
programmatic session lane first, then prune it explicitly:

```bash
hermes sessions prune --source tool --older-than 1h --dry-run
hermes sessions prune --source tool --older-than 1h --yes
```

Repeat with `--profile myboonfeed` for the news profile. Never run an
unfiltered session prune on the production host.

---

## Pipeline state lives in SQLite on this box

Temporary pipeline state lives in local SQLite files, not Supabase:

```
packages/collectors/.data/pipeline.sqlite # Polymarket candidates/research/queues
packages/collectors/.data/news.sqlite     # news candidates/dedupe/research/queues
```

- These files are the pipelines' queues and working memory. Deleting either loses
  in-flight work. It is not in git and is not reproducible from Supabase.
- Backlog / per-stage status for both Polymarket and news:
  `pnpm --filter @myboon/collectors pipeline-store:status`
- Verified online backups for both `pipeline.sqlite` and `news.sqlite`:
  `pnpm --filter @myboon/collectors pipeline-store:backup`
  (run it on a cron; it is cheap)
- Restore is deliberately a separate, dry-run-first command and never chooses a
  live target implicitly. Review the integrity output, stop the owning workers,
  and then repeat with `--apply`; add `--force` only when replacing an existing
  target is explicitly approved:
  ```bash
  pnpm --filter @myboon/collectors pipeline-store:restore -- \
    --store news --backup /absolute/path/news.sqlite.backup \
    --target /absolute/path/news.sqlite.restored
  pnpm --filter @myboon/collectors pipeline-store:restore -- \
    --store news --backup /absolute/path/news.sqlite.backup \
    --target /absolute/path/news.sqlite.restored --apply
  ```
  The command verifies the selected backup before copying and verifies the
  restored file afterward. It does not delete the backup or infer production
  paths.
- Failed-work recovery is dry-run first and stage-specific. Examples:
  ```bash
  pnpm --filter @myboon/collectors pipeline-store:recover-research -- \
    --source news --since 2026-08-23T00:00:00Z --until 2026-08-24T00:00:00Z
  pnpm --filter @myboon/collectors pipeline-store:recover-entity-manager -- \
    --source polymarket --since 2026-08-23T00:00:00Z --failure-category provider_outage
  ```
  Add `--apply` only after reviewing every audit row. Apply requires a time
  boundary or exact `--candidate-id`, limits each invocation to 100 rows by
  default (maximum 500), and backs up and verifies both SQLite files before
  writing. Research replay never reruns candidates that already have a local
  result; it reconciles their candidate cursor directly to `researched`.
  Use `--mark-dead-letter --apply` for terminal failures that should remain
  visible but never be reclaimed.
- Dead-letter depth and oldest stuck row for all four queues:
  `pnpm --filter @myboon/collectors pipeline-store:dead-letters`
- The three production news workers must all use the same `NEWS_SQLITE_PATH`.
- News Entity Manager reads research packets from `news.sqlite` and writes only
  final `entities` and `entity_memories` records to Supabase.
- Supabase product tables remain available to the app/API, including `entities`,
  `entity_memories`, `published_narratives`, and `entity_published_history`.
- Migration `20260818145731_drop_retired_pipeline_tables.sql` removes the retired
  Supabase news, Polymarket working-state, and editor-draft tables. It does not
  touch either local SQLite file or any durable entity/publishing table.

### Feed V3 staged controls (safe-off; not yet a production cutover)

Feed V3 adds canonical Signals, durable triage decisions, shared research work,
immutable evidence/packets, shadow observations, and execution events as
additive tables inside the same two SQLite databases. The ecosystem registers
one shared Research process and one shared Entity Manager process, but both stay
resident with zero database/provider/network I/O while their mode is `off`.
Legacy lanes remain the only claimers until a separately reviewed,
stage-by-stage and source-by-source cutover. All Feed V3 modes are safe-off by
default:

```dotenv
FEED_V3_INTAKE_MODE=off
FEED_V3_RESEARCH_MODE=off
FEED_V3_ENTITY_MODE=off
FEED_V3_ACTIVE_SOURCES=
FEED_V3_SHADOW_SOURCES=
FEED_V3_INTAKE_ACTIVE_SOURCES=
FEED_V3_INTAKE_SHADOW_SOURCES=
FEED_V3_RESEARCH_ACTIVE_SOURCES=
FEED_V3_RESEARCH_SHADOW_SOURCES=
FEED_V3_ENTITY_ACTIVE_SOURCES=
FEED_V3_ENTITY_SHADOW_SOURCES=
FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES=
FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES=
FEED_V3_CUTOVER_RECEIPT_PATH=
FEED_V3_SHADOW_SAMPLE_BASIS_POINTS=0
FEED_V3_DEEP_RESEARCH_ENABLED=0
FEED_V3_TRIAGE_CLASSIFIER_ENABLED=0
FEED_V3_TRIAGE_PROVIDER_HEALTH=unavailable
FEED_V3_TRIAGE_ALLOWED_DEPTHS=light
FEED_V3_RESEARCH_RECOVERY_INTERVAL_MS=30000
FEED_V3_RESEARCH_RECOVERY_LIMIT_PER_SOURCE=100
FEED_V3_RESEARCH_DRAIN_GRACE_MS=150000
FEED_V3_RESEARCH_RUNTIME_STATUS_PATH=.data/feed-v3-research-runtime-status.json
FEED_V3_ENTITY_RUNTIME_STATUS_PATH=.data/feed-v3-entity-runtime-status.json
FEED_V3_RUNTIME_CONTROL_PATH=.data/feed-v3-runtime-control.json
FEED_V3_RESEARCH_RUNTIME_STATUS_STALE_MS=60000
FEED_V3_ENTITY_RUNTIME_STATUS_STALE_MS=60000
```

Structured inference routes are configured once through the Inference Gateway.
`INFERENCE_GATEWAY_WORKLOAD_POLICIES_JSON` may override a reviewed workload's
`reasoningEffort`, process-local `maxConcurrency`, and windowed `rateLimit`;
omitted workloads retain code-owned defaults. The Hermes structured semaphore
remains the cross-process capacity ceiling. Requested reasoning effort is not
observed provider behavior: Hermes one-shot does not expose an actual-effort
measurement.

Use the stage-specific source sets for new deployments; the two global source
sets are compatibility fallbacks only. Unsupported research depths are
persisted as typed `defer` decisions and are never silently downgraded. Standard
research additionally requires a code-registered search connector and reviewed
policy. Deep remains disabled until the VPS containment gate passes.

The runtime refuses active Research or Entity ownership when the matching
legacy claimer has not been explicitly disabled. Never set a mode to `active`
until the shadow evaluation, migration, rollback, and cutover gates in the PRD
pass. Remove only the retired registrations and load the shared processes from
the ecosystem (not plain `pm2 restart all`):

```bash
pm2 delete myboon-news-researcher 2>/dev/null || true
pm2 delete myboon-polymarket-researcher 2>/dev/null || true
pm2 delete myboon-news-entity-manager 2>/dev/null || true
pm2 delete myboon-polymarket-entity-manager 2>/dev/null || true
pm2 startOrReload ecosystem.config.cjs --only myboon-feed-v3-research --update-env
pm2 startOrReload ecosystem.config.cjs --only myboon-feed-v3-entity-manager --update-env
pm2 save
```

### Feed V3 Phase 1 controlled activation (News + Polymarket only)

Phase 1 is the first production cutover of the shared Research and shared Entity
workers, scoped to exactly News and Polymarket. It is a controlled, reversible
activation — not the full cutover. The full policy still requires the reviewed
receipt manifest plus the 1000-row shadow evaluation and rollback-rehearsal
artifacts before any active shared ownership; Phase 1 deliberately runs without
a receipt and is bounded to the invariants below.

#### Phase 1 env contract

The exact Phase 1 environment. Every value is required; do not mix it with the
full cutover policy.

```dotenv
FEED_V3_CUTOVER_POLICY=phase1
FEED_V3_INTAKE_MODE=active
FEED_V3_RESEARCH_MODE=active
FEED_V3_ENTITY_MODE=active
FEED_V3_INTAKE_ACTIVE_SOURCES=news,polymarket
FEED_V3_RESEARCH_ACTIVE_SOURCES=news,polymarket
FEED_V3_ENTITY_ACTIVE_SOURCES=news,polymarket
FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES=news,polymarket
FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES=news,polymarket
FEED_V3_TRIAGE_ALLOWED_DEPTHS=light
FEED_V3_DEEP_RESEARCH_ENABLED=0
FEED_V3_TRIAGE_CLASSIFIER_ENABLED=0
FEED_V3_TRIAGE_PROVIDER_HEALTH=healthy
NEWS_SQLITE_PATH=.data/news.sqlite
PIPELINE_SQLITE_PATH=.data/pipeline.sqlite
INFERENCE_GATEWAY_PRIMARY_PROVIDER=ollama-cloud
INFERENCE_GATEWAY_PRIMARY_MODEL=deepseek-v4-flash
```

Contract notes:

- Intake, Research, and Entity active sources are `news,polymarket`; the legacy
  Research and Entity disabled-source declarations are also `news,polymarket`.
- Cutover policy is `phase1`; allowed depth is exactly `light`; deep is `0`;
  the triage classifier is `0`; provider health is `healthy`.
- Source SQLite paths remain the two existing physical stores under one queue
  contract: `news.sqlite` for News and `pipeline.sqlite` for Polymarket. No
  third Feed V3 SQLite path is introduced.
- The gateway provider/model are explicit (`ollama-cloud` /
  `deepseek-v4-flash`); the shared workers never fall back to an unapproved
  route.
- The full policy still requires the existing reviewed receipt and the
  1000-row evaluation / rollback-rehearsal artifacts. Phase 1 does not
  substitute for them; it is a bounded, reversible first activation.

#### Activation runbook

1. Back up both SQLite databases and verify the backups:
   ```bash
   pnpm --filter @myboon/collectors pipeline-store:backup
   ```
2. Verify Hermes/profile and Entity migration readiness without printing
   secrets:
   ```bash
   hermes --version
   hermes profile list
   pnpm --filter @myboon/collectors feed-v3:verify-entity-migration
   ```
   (The verifier reports readiness only; it never prints credentials.)
3. Set the Phase 1 env contract above in the shell that invokes PM2 (or in
   `packages/collectors/.env`). Do not hardcode an active mode in the
   ecosystem file.
4. Remove only the four retired registrations, then reload the two scouts and
   two shared owners from the reviewed ecosystem. This leaves API, editor,
   publisher, sweeper, and unrelated PM2 apps untouched:
   ```bash
   pm2 delete myboon-news-researcher 2>/dev/null || true
   pm2 delete myboon-polymarket-researcher 2>/dev/null || true
   pm2 delete myboon-news-entity-manager 2>/dev/null || true
   pm2 delete myboon-polymarket-entity-manager 2>/dev/null || true
   pm2 startOrReload ecosystem.config.cjs --only myboon-news-feed-ingestor --update-env
   pm2 startOrReload ecosystem.config.cjs --only myboon-polymarket-data-engineer --update-env
   pm2 startOrReload ecosystem.config.cjs --only myboon-feed-v3-research --update-env
   pm2 startOrReload ecosystem.config.cjs --only myboon-feed-v3-entity-manager --update-env
   pm2 save
   ```
5. Verify:
   - shared workers online: `pm2 list` shows `myboon-feed-v3-research` and
     `myboon-feed-v3-entity-manager` online;
   - clean ownership: `pm2 list` contains none of
     `myboon-news-researcher`, `myboon-polymarket-researcher`,
     `myboon-news-entity-manager`, or `myboon-polymarket-entity-manager`;
   - API, publisher, and editor unchanged: `myboon-api`, `myboon-publisher`,
     and `myboon-editor-draft` remain online with no config change;
   - source-local queue progress: `pnpm --filter @myboon/collectors
     feed-v3:status` shows News and Polymarket arrivals/admissions advancing;
   - no duplicate claims/memories: `feed-v3:status` reports zero duplicate
     artifacts and the Entity snapshot shows no duplicate memory writes;
   - bounded errors: `pm2 logs` shows no crash loop and no unbounded retry.

#### Rollback sequence

Rollback reverses ownership without overlap and never runs migrations or
deletes data.

1. Drain both shared workers and wait for status to report no active execution:
   ```bash
   pnpm --filter @myboon/collectors feed-v3:runtime-control -- --stage research --action drain --apply
   pnpm --filter @myboon/collectors feed-v3:runtime-control -- --stage entity --action drain --apply
   ```
2. Return shared modes off and policy full:
   ```bash
   export FEED_V3_CUTOVER_POLICY=full
   export FEED_V3_INTAKE_MODE=off
   export FEED_V3_RESEARCH_MODE=off
   export FEED_V3_ENTITY_MODE=off
   export FEED_V3_INTAKE_ACTIVE_SOURCES=
   export FEED_V3_RESEARCH_ACTIVE_SOURCES=
   export FEED_V3_ENTITY_ACTIVE_SOURCES=
   export FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES=
   export FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES=
   ```
3. If rollback only means stopping Feed V3 processing, reload only the two
   scouts and shared workers with those safe-off values. If source-specific legacy processing
   is required, first deploy the reviewed earlier known-good commit whose
   ecosystem still contains those workers; then follow that release's reviewed
   deployment procedure.
   Never reintroduce old app registrations by an ad-hoc PM2 command.
   ```bash
   pm2 startOrReload ecosystem.config.cjs --only myboon-news-feed-ingestor --update-env
   pm2 startOrReload ecosystem.config.cjs --only myboon-polymarket-data-engineer --update-env
   pm2 startOrReload ecosystem.config.cjs --only myboon-feed-v3-research --update-env
   pm2 startOrReload ecosystem.config.cjs --only myboon-feed-v3-entity-manager --update-env
   pm2 save
   ```
4. Verify `feed-v3:status` reports the shared workers off with no active claims.
   For an earlier-release rollback, additionally verify its expected legacy
   owners only after that reviewed code/config is deployed.

Read-only status and trace commands:

```bash
pnpm --filter @myboon/collectors feed-v3:status
pnpm --filter @myboon/collectors feed-v3:trace -- --work-id work_...
```

Status reports durable source-observation and dedup counts when the additive
observation ledger is present. Monetary cost is reported only from measured
`costUsdMicros` execution telemetry, with explicit coverage; missing prices are
never inferred from token counts. SQLite historical write-error counts remain
explicitly unavailable unless a durable external collector is registered.
Missing or corrupt News/Pipeline stores produce typed partial status/trace
output instead of hiding healthy sources.

Alerts remain explicitly unavailable until reviewed thresholds are supplied as
credential-free `FEED_V3_STATUS_ALERT_POLICY_JSON` with `queueAgeSloMs` P0/P1
thresholds by source, `providerErrorRateThreshold`, and
`deadLetterCountThreshold`. The status output records whether alert evaluation
was available; it never substitutes default SLOs.

The additional initial-alert checks use a separate reviewed
`FEED_V3_OPERATIONAL_ALERT_POLICY_JSON` containing
`minimumThroughputWindowMs`, `minimumCompletionAdmissionRatio`, and
`sqliteWriteErrorCountThreshold`. Circuit-open and containment-survivor alerts
come from the atomic Research/Entity runtime snapshots. Completion/admission
uses an independent 30-minute SQLite activity window while provider failures
retain their five-minute window. Missing/stale runtime snapshots, an
unconfigured policy, and unavailable SQLite write-error collection are emitted
as explicit coverage gaps rather than treated as healthy.
Set `FEED_V3_STATUS_ACTIVITY_WINDOW_MS` to the exact reviewed throughput window
(default `1800000`); a policy requesting a longer window than the status sample
is reported unavailable rather than evaluated on partial history.

Research capacity is split into urgent and background pools. Inside an equal
priority class, `FEED_V3_RESEARCH_MAX_CONSECUTIVE_CLAIMS_PER_SOURCE` bounds a
single adapter's claim burst (default `2`); it never lets lower-priority work
jump ahead of P0/P1 work.

Historical packet quality is evaluated separately from triage. First prepare
reviewer-safe A/B assignments and a private mapping manifest; the assignments
omit packet/work/signal identity, provider, model, usage, and cost:

```bash
pnpm --filter @myboon/collectors feed-v3:prepare-packet-comparison -- \
  --input packet-pairs.jsonl --dataset-id 2026-08-news-poly \
  --assignments-out /absolute/private/reviewer-assignments.json \
  --manifest-out /absolute/private/packet-manifest.json
```

After reviewers return `myboon.blind_packet_score.v1` rows, evaluate the private
manifest with a reviewed threshold JSON file:

```bash
pnpm --filter @myboon/collectors feed-v3:evaluate-packet-comparison -- \
  --manifest /absolute/private/packet-manifest.json \
  --reviews /absolute/private/reviews.json \
  --thresholds /absolute/private/packet-thresholds.json
```

The aggregate artifact joins A/B scores to current/proposed identities only
after review. Every score carries the assignment-content digest and the private
manifest independently reconstructs and verifies that digest, so a modified
review packet cannot be silently joined. The evaluator meters usage from the validated canonical packets, enforces zero
interactive tools, and contains neither packet prose nor route identity. A
real reviewed data set is still required; these commands do not fabricate it.

Externally produced rollback-rehearsal and live-soak evidence can be validated
and redacted without asserting that the evidence exists:

```bash
pnpm --filter @myboon/collectors feed-v3:validate-operational-evidence -- \
  --kind rollback --input /absolute/path/rollback.json
pnpm --filter @myboon/collectors feed-v3:validate-operational-evidence -- \
  --kind live-soak --input /absolute/path/live-soak.json
pnpm --filter @myboon/collectors feed-v3:validate-operational-evidence -- \
  --kind provider-outage --input /absolute/path/provider-outage.json
```

The validator rejects a claimed pass when measured duration, rollback bounds,
SQLite errors, dead-letter threshold, ownership restoration, queue integrity,
or orphan results contradict it. Provider-outage evidence additionally binds a
tracked cohort and proves zero claims, attempts, provider calls, and terminal
failures while open; exactly one half-open probe; recovery progress; and zero
duplicate artifacts. It does not generate production evidence.

`feed-v3:status` reports Research and Entity runtime snapshot availability as
`current`, `stale`, `missing`, or `invalid`. The Entity snapshot contains only
the desired drain state, measured `entity.extract` provider success/duration,
and circuit/next-probe state. It never contains prompts, evidence, credentials,
raw provider errors, token usage, or inferred costs. Entity mode `off` does not
create or read the snapshot file.

Retention inventory is also strictly read-only. It requires an explicit cutoff,
accepts `--store news`, `--store pipeline`, or `--store both`, and reports exact
eligible counts plus at most 500 metadata-only samples per table and SQLite
main/WAL/SHM sizes. It inventories only terminal canonical queue rows, terminal
execution rows, source-routed Research and Entity shadow observations, and
expired deep-registry entries with a boolean temp artifact check. Entity shadow
observations are read from `news.sqlite` for News and `pipeline.sqlite` for the
pipeline-routed sources. It never opens a writable database, creates a table,
reads entity/entity-memory content, or exposes an apply/delete option:

```bash
pnpm --filter @myboon/collectors feed-v3:retention-preview -- \
  --store both --before 2026-08-01T00:00:00Z --limit 25
```

Review this output as planning evidence only. Any future deletion or archival
workflow requires a separately reviewed implementation and backup procedure.

The Feed V3 load/soak harness is non-production evidence tooling for the
canonical SQLite queue, scheduler, leases, retries, and state transitions only.
It never invokes a provider, Supabase, legacy table, or production database.
Both paths must be explicit absolute paths, the fixture database must be new,
and the command refuses the configured `NEWS_SQLITE_PATH` and
`PIPELINE_SQLITE_PATH`. It is dry-run by default; add `--execute` to create the
fixture and write the versioned JSON artifact:

```bash
pnpm --filter @myboon/collectors feed-v3:load-soak -- \
  --fixture-db /absolute/scratch/feed-v3-load.sqlite \
  --output /absolute/scratch/feed-v3-load-artifact.json \
  --duration-seconds 300 \
  --baseline-arrivals-per-second 2 \
  --arrival-multiplier 2 \
  --completion-capacity-per-second 4 \
  --max-queue-depth 25 \
  --min-completion-ratio 0.99 \
  --execute
```

The harness is bounded to 100,000 offered items and a maximum logical duration
of 24 hours. Executed runs are paced against monotonic wall time; their artifact
reports measured offered/admitted/completed rates, wall time, queue p95
and maximum depth, duplicate/collision/failure counts, SQLite errors, reviewed
thresholds, and pass/fail reasons. This deterministic logical-clock simulation
does not satisfy AC22 wall-clock 2x throughput or AC23's live 24-hour soak by
itself. It also cannot satisfy provider-outage, deep-containment, Supabase, or
end-to-end Product Surface acceptance gates; those require separately reviewed
live evidence.

Status includes source-local arrivals, admissions, completions, attempts,
priority/depth queue ages, dead letters, typed recent failures, and measured
provider/fallback usage. It also reads the shared Research process's redacted
runtime file and the shared Entity process's independent redacted health file,
labeling each `current`, `stale`, `missing`, or `invalid`. Both expose only the
latest measured route/provider outcome, duration, circuit readiness, and
next-probe time; Entity also reports its durable drain/control state.
Circuit state is process-local and is not reconstructed from SQLite. Shadow results remain in
the source DB: News in `news.sqlite`; Polymarket, Market Calendar, and X in
`pipeline.sqlite`. The verified backup inventory includes these additive shadow
and execution tables.

The shared Research runner also atomically refreshes its redacted runtime snapshot
in active/shadow mode. The snapshot contains measured last-call duration and
success, route/circuit state, and next-probe timestamps; it contains no prompts,
evidence, credentials, or invented cost. Off mode never creates or reads this
file. On startup and every bounded recovery interval, active mode returns
expired leases and due retry waits to their recorded pending stages without
spending attempts. SIGTERM immediately gates new claims and drains the current
call for `FEED_V3_RESEARCH_DRAIN_GRACE_MS`; PM2 `kill_timeout` must remain larger
than that grace before deploying an override.

The shared Entity runner refreshes its health snapshot after active/shadow
cycles and on drain/stop. Health writes are best-effort observability: a
missing/unwritable snapshot is visible to `feed-v3:status` but cannot change a
queue result or trigger provider work. Entity off mode performs no health or
runtime-control I/O.

Controlled drain/resume is durable across PM2 restarts and does not require a
database or provider connection. Commands are dry-run unless `--apply` is
explicit; inspect the proposed revision before applying it:

```bash
pnpm --filter @myboon/collectors feed-v3:runtime-control -- \
  --stage research --action drain
pnpm --filter @myboon/collectors feed-v3:runtime-control -- \
  --stage research --action drain --apply

# After deployment/restart and queue verification:
pnpm --filter @myboon/collectors feed-v3:runtime-control -- \
  --stage research --action resume --apply
```

The same command accepts `--stage entity`. A drained resident worker finishes
its current bounded call, performs no new claims, and reports `draining` until
an applied resume. The control document is atomically replaced with mode 0600;
do not edit it by hand. Its lock contains an owning PID and token: a dead-owner
lock is reclaimed, while a partial lock is reclaimed only after a one-minute
age gate. A live owner's lock is never stolen.

Historical evaluation/backfill is dry-run by default, bounded to 500 rows, and
does not claim or mutate legacy work. `--apply` verifies backups of both SQLite
databases before opening the additive canonical stores:

The reviewed labeled evaluation set can be JSON or JSONL. Produce a redacted,
content-free cutover artifact by supplying the approved thresholds explicitly;
the default minimum is 1,000 records and a failed gate exits with status 2:

```bash
pnpm --filter @myboon/collectors feed-v3:evaluate-triage -- \
  --input /absolute/path/feed-v3-labeled-evaluation.jsonl \
  --max-false-negative-rate 0.05 \
  --min-metered-completion-rate 1 \
  --max-provider-calls-per-completion 2 \
  --max-input-tokens-per-completion 5000 \
  --max-output-tokens-per-completion 1000 \
  --max-p95-latency-ms 90000 \
  --min-blind-review-rate 1 \
  --min-blind-acceptance-rate 0.95 \
  --min-blind-product-quality 3 \
  --min-blind-evidence-quality 3 \
  --min-blind-attribution-quality 3 \
  > /absolute/path/feed-v3-evaluation-artifact.json
```

The artifact records the input SHA-256 digest, thresholds, aggregate metrics,
source, stage, exact sample size, and pass/fail reasons. Blind review rows must
attest that provider, model, usage, and cost were hidden and contain only a
versioned protocol, reviewer hash, numeric product/evidence/attribution scores,
and acceptance. Record and Signal identities are hashed in the artifact; it
contains no Signal title, summary, prompt, evidence, or credential. The 1,000
row minimum is enforced for every included source. Run the evaluation
separately for every source being approved; a mixed-source artifact cannot
authorize a source-specific cutover.

Full-policy active Research and Entity startup requires a manifest at
`FEED_V3_CUTOVER_RECEIPT_PATH`. Phase 1 instead uses its receipt-free,
News/Polymarket-only policy guard described above. Under the full policy, each
source/stage receipt is an explicit manual
attestation binding the reviewed shadow artifact and rollback-rehearsal artifact
by relative path, schema version, and SHA-256 digest. Artifact paths must remain
inside the manifest directory, the shadow sample must contain at least 1,000
rows, rollback rehearsal must precede approval, and receipts expire. Changing
even one artifact byte invalidates startup. This is an operator review control,
not a cryptographic signature or a substitute for the production soak.

Minimal manifest shape (digests shown are placeholders):

```json
{
  "schemaVersion": "myboon.feed_v3_cutover_manifest.v1",
  "receipts": [{
    "schemaVersion": "myboon.feed_v3_cutover_receipt.v1",
    "receiptId": "news-research-20260826",
    "sourceType": "news",
    "stage": "research",
    "approvedAt": "2026-08-26T12:00:00.000Z",
    "approvedBy": "release-owner",
    "attestationMode": "manual_review",
    "expiresAt": "2026-08-28T12:00:00.000Z",
    "shadowEvaluation": {
      "sampleSize": 1000,
      "passed": true,
      "artifactPath": "news-research-shadow.json",
      "artifactSchemaVersion": "myboon.feed_v3_triage_evaluation.v1",
      "artifactSha256": "<64 lowercase hex characters>"
    },
    "rollbackRehearsal": {
      "rehearsedAt": "2026-08-26T11:00:00.000Z",
      "passed": true,
      "artifactPath": "news-research-rollback.json",
      "artifactSchemaVersion": "myboon.feed_v3_rollback_rehearsal.v1",
      "artifactSha256": "<64 lowercase hex characters>"
    }
  }]
}
```

#### Research source ownership cutover and rollback

The PM2 ecosystem has one shared Research registration and no source-specific
Research registrations. Ownership changes therefore use the reviewed policy
and a controlled clean PM2 rebuild; never start an old researcher by name from
the current ecosystem. Full-policy source cutover still requires a receipt for
each source/stage pair. Rollback to source-specific Research requires deploying
the reviewed earlier release first, followed by another clean PM2 rebuild.

#### Entity source ownership cutover and rollback

The PM2 ecosystem has one shared Entity registration and no source-specific
Entity registrations. Source/stage receipts and migration readiness still fail
closed before database, provider, or claim I/O under the full policy. Rollback
to source-specific Entity processing requires deploying the reviewed earlier
release first, followed by a controlled clean PM2 rebuild; it is not an
in-place PM2 toggle.

```bash
pnpm --filter @myboon/collectors feed-v3:backfill -- \
  --source news --since 2026-08-24T00:00:00Z --until 2026-08-25T00:00:00Z --batch 25

# Only after reviewing every reported row:
pnpm --filter @myboon/collectors feed-v3:backfill -- \
  --source news --since 2026-08-24T00:00:00Z --until 2026-08-25T00:00:00Z --batch 25 --apply
```

Canonical recovery is also dry-run by default and accepts `--source`,
`--stage`, `--failure-category`, `--work-id`, `--since`, `--until`, and a
bounded `--batch` (maximum 500):

```bash
pnpm --filter @myboon/collectors feed-v3:recover -- \
  --source news --stage synthesis --since 2026-08-26T00:00:00Z --batch 25

# Only after reviewing the dry-run rows:
pnpm --filter @myboon/collectors feed-v3:recover -- \
  --source news --stage synthesis --since 2026-08-26T00:00:00Z --batch 25 --apply
```

`--apply` takes and verifies the affected online SQLite backup before any row is
changed, performs compare-and-swap recovery, and writes an immutable audit event
for every recovered row. It never deletes signals, evidence, packets, execution
events, or attempt history.

The committed migration
`20260826175053_add_entity_memory_identity_key.sql` introduces the stable,
title-independent identity used by canonical Entity Memory writes. Apply it only
as part of the reviewed Entity Manager cutover; this branch does not apply or
link Supabase. The migration backfills existing rows one-for-one and retains the
legacy unique index for rolling compatibility. After rehearsing or applying the
migration through the separately approved Supabase workflow, verify all
required columns, indexes, RPCs, grants, trigger, and identity counts before an
active Entity worker can claim anything:

```bash
pnpm --filter @myboon/collectors feed-v3:verify-entity-migration
```

The versioned Entity Knowledge read surface is internal and requires
`Authorization: Bearer $INTERNAL_DASHBOARD_TOKEN`:

```text
GET /internal/entity-knowledge/recent
GET /internal/entity-knowledge/entities/:entityId/memories
GET /internal/entity-knowledge/changes
```

Responses are allowlisted consumer DTOs; raw memory context, evidence bodies,
provider details, and internal provenance are not exposed.

Deep research remains disabled until the transient-systemd-service checks in
[`2026_08_26_deep_research_transient_systemd_service.md`](modules/entity-manager/ADRs/2026_08_26_deep_research_transient_systemd_service.md)
are completed on the target VPS. No local test result is evidence that the VPS
cgroup, timeout, descendant-kill, or temporary-profile requirements have passed.
The durable registry can be audited without creating tables, killing units, or
deleting workspaces:

```bash
pnpm --filter @myboon/collectors feed-v3:deep-orphan-audit
```

With no arguments the audit reads both configured source databases (News and
Pipeline, deduplicating identical physical paths); it never creates a missing
database or table. `--registry /absolute/scratch.sqlite` remains available for
the synthetic verifier or a manual scratch audit. The command exits with status
2 when either production database is missing, an expired unit/workspace appears orphaned,
or systemd/filesystem inspection is incomplete. Its JSON omits trace IDs,
profile paths, and temporary paths. Cleanup remains an explicit, separately
reviewed operation.

The VPS containment verifier is also opt-in. It runs only the checked-in
`descendant-timeout-v1` synthetic fixture, which deliberately leaves a child
alive until the transient service timeout kills the whole control group. Use
dedicated absolute registry and artifact paths; do not point it at the live
registry. Both files must be new inside an existing scratch directory. The
command resolves parent directories and refuses the configured News/Pipeline
databases, aliases through symlinks, duplicate flags, existing targets, and
registry/artifact collisions; artifact publication is atomic mode-0600 and
never replaces an existing file. The artifact is redacted and records unit inactivity, registry
cleanup, and temporary-workspace cleanup, but it does not enable Deep Research:

```bash
pnpm --filter @myboon/collectors feed-v3:verify-deep-containment -- \
  --apply \
  --fixture descendant-timeout-v1 \
  --registry /var/lib/myboon/verification/deep-registry.sqlite \
  --artifact /var/lib/myboon/verification/deep-containment.json
```

Keep `FEED_V3_DEEP_RESEARCH_ENABLED=0` until that host artifact, the cutover
receipt, contained executable, exact public-domain/tool policy, and source-local
registry storage have all been reviewed. The shared Research runner validates
those settings and systemd readiness before acquiring a deep lease. Successful
contained output still fails closed unless the trusted usage sidecar and
fetched-evidence manifest are present and within the canonical work budget.
Exact-domain job and output validation is not proof of OS-enforced destination
egress; the target-host review must separately prove the approved network
policy before Deep can be enabled.
The configured audit roots must already exist as dedicated `myboon-deep*`
directories outside the checkout and operator home; `/` and broad roots such as
`/tmp` are rejected. Discovery runs at startup and on a bounded five-minute
cadence, with forced refresh after timeout or cleanup failure. The gateway sends
the configured reasoning policy to its adapter, but Hermes one-shot currently
has no per-call reasoning flag, so actual reasoning effort remains unmeasured.
Verify the selected Hermes profile/provider capability before cutover; runtime
status must not be treated as evidence that reasoning effort was enforced.

---

## First-time VPS setup

```bash
# 1. Install PM2 globally
npm install -g pm2

# 2. Clone repo and install deps
git clone <repo> myboon && cd myboon
pnpm install

# 3. Create .env files (never committed)
#    packages/api/.env
#    packages/collectors/.env

# 4. Start all processes
pm2 start ecosystem.config.cjs

# 5. Save process list and enable startup on reboot
pm2 save
pm2 startup   # run the printed command as root/sudo
```

---

## Day-to-day operations

```bash
# Pull latest and reload (zero-downtime for API)
# Apply pending Supabase migrations first when new migrations exist.
# - supabase/migrations/20260818145731_drop_retired_pipeline_tables.sql
#   (removes only retired temporary pipeline tables after the SQLite cutover)
# Currently pending (entity pipeline rebuild):
# - supabase/migrations/20260728_entity_memories_drop_source_marker.sql
#   (safe to apply: every source_marker WRITE was removed in the rebuild;
#   this drops the CHECK-constraint allowance for that memory_type)
infra/vps/deploy.sh

# Or manually:
git pull --ff-only && pnpm install --frozen-lockfile
pnpm --filter @myboon/shared build
pnpm --filter @myboon/tx-parser build
pnpm --filter @myboon/collectors build
# Remove only retired registrations; reload reviewed apps without deleting API.
pm2 delete myboon-news-researcher 2>/dev/null || true
pm2 delete myboon-polymarket-researcher 2>/dev/null || true
pm2 delete myboon-news-entity-manager 2>/dev/null || true
pm2 delete myboon-polymarket-entity-manager 2>/dev/null || true
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

# Watch all logs
pm2 logs

# Watch a specific process
pm2 logs myboon-api
pm2 logs myboon-feed-v3-research

# Process status overview
pm2 list

# Interactive monitor (CPU/memory/logs)
pm2 monit

# Restart a single process
pm2 restart myboon-polymarket-data-engineer
pm2 restart myboon-news-feed-ingestor
pm2 restart myboon-feed-v3-research
pm2 restart myboon-feed-v3-entity-manager
pm2 restart myboon-editor-draft
pm2 restart myboon-publisher

# Stop everything
pm2 stop all

# Delete all (nuclear — re-run start after)
pm2 delete all
```

---

## .env reference

Each package loads its own `.env` via `dotenv/config`. PM2 sets `cwd` to the package directory so dotenv finds the right file.

### `packages/api/.env`
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TOKENS_API_KEY=
INTERNAL_DASHBOARD_TOKEN=
INTERNAL_ENTITY_WRITE_TOKEN=
INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN=
PORT=3000
```

### Internal dashboard web environment

The public web deployment may host `/internal/entities` and
`/internal/polymarket`, but these routes are not public data. Configure these
values in the deployment provider's private
environment-variable store only. Do not add secret values to source files,
GitHub issues, CI logs, or browser-accessible `NEXT_PUBLIC_*` variables.

```text
INTERNAL_DASHBOARD_TOKEN=
INTERNAL_DASHBOARD_SESSION_SECRET=
INTERNAL_DASHBOARD_AUTH_BYPASS=0
INTERNAL_ENTITY_WRITE_TOKEN=
INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN=
INTERNAL_API_BASE_URL=https://internal-api.example.com
```

Use the same `INTERNAL_DASHBOARD_TOKEN` for the API and web deployments. Use a
separate `INTERNAL_ENTITY_WRITE_TOKEN` for privileged preview/apply operations,
and a separate `INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN` for catalog draft and
publish operations. Configure write tokens only on the API and web server.
Generate all secrets independently with at least 32 random bytes, for example:

```bash
openssl rand -base64 48
```

For local UI development only, `INTERNAL_DASHBOARD_AUTH_BYPASS=1` skips the web
dashboard login/session prompt. The bypass is ignored when `NODE_ENV=production`
and never disables API read or write credentials. Keep it unset or `0` in every
deployed environment.

`INTERNAL_API_BASE_URL` is server-to-server only. Keep the API on a private
network or allow it only from the web deployment where the platform supports
network allowlists. The browser must never call the API host directly.

Before deploying the API, apply pending migrations, including the Polymarket
catalog tables and draft/publish RPCs:

```bash
pnpm dlx supabase db push
```

### `packages/collectors/.env`
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TOKENS_API_KEY=
NEWS_SQLITE_PATH=.data/news.sqlite

# --- Hermes (central service: src/hermes/) ---
# HERMES_COMMAND=hermes            # override the CLI binary if not on PATH
# HERMES_BROWSER_MAX_CONCURRENCY=2
# HERMES_BROWSER_CONCURRENCY_LOCK_DIR=/tmp/myboon-hermes-slots
# HERMES_STRUCTURED_MAX_CONCURRENCY=4
# HERMES_STRUCTURED_CONCURRENCY_LOCK_DIR=/tmp/myboon-hermes-structured-slots
# Legacy HERMES_MAX_CONCURRENCY/HERMES_CONCURRENCY_LOCK_DIR are browser fallbacks
# HERMES_ORPHAN_SWEEP_INTERVAL_MS=300000
# HERMES_ORPHAN_MAX_AGE_MS=900000
# HERMES_ORPHAN_KILL_GRACE_MS=5000
# EDITOR_DRAFT_HERMES_TIMEOUT_MS=600000

# --- Shared Feed V3 Research + Entity ---
# Use the exact Phase 1 contract above. There is no source-specific Research or
# Entity fallback in the current PM2 ecosystem.

POLYMARKET_MARKETS_RUN_ONCE=0
NEWS_FEED_RUN_ONCE=0
NEWS_FEED_INTERVAL_MS=600000
EDITOR_DRAFT_RUN_ONCE=0
EDITOR_DRAFT_INTERVAL_MS=3600000
EDITOR_DRAFT_BATCH_SIZE=2
PUBLISHER_RUN_ONCE=0
PUBLISHER_INTERVAL_MS=300000
PUBLISHER_BATCH_SIZE=10
PUBLISHER_PREVIEW_ONLY=0
```

---

## Smoke test (after deploy)

```bash
curl http://localhost:3000/health
# {"status":"ok"}

pnpm --filter @myboon/api smoke

# Pipeline: per-stage backlog + statuses (should list stages, not error)
pnpm --filter @myboon/collectors pipeline-store:status

# Watch the researcher's first cycle end-to-end. Expect gate verdicts in the
# result JSON (skippedRecentlyResearched / skipped[].reason gate_already_known)
# and engine outcomes (nothingFound count, research_backend research_engine).
pm2 logs myboon-feed-v3-research --lines 100
```

After a restart following downtime, prefer a cautious first cycle: watch the
first few shared Research outcomes by hand before trusting the cadence. If it
misbehaves, drain Research through `feed-v3:runtime-control`, set
`FEED_V3_RESEARCH_MODE=off`, and perform the controlled clean PM2 rebuild.
