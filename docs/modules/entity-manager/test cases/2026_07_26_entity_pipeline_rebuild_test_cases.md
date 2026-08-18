# Entity Pipeline Rebuild — Test Cases

Date: 2026-07-26
Source PRD: [`2026_07_26_entity_pipeline_rebuild_PRD.md`](../PRDs/2026_07_26_entity_pipeline_rebuild_PRD.md)
Module: entity-manager
Scope: the PRD's five phases, plus the destructive Phase 0/1 operations.

Implementation note (2026-08-18): the final approved drop list is eight tables,
not the eleven-table draft assumed by some historical pre-flight cases below.
`pipeline_runs` and all Hyperliquid tables remain. The production news store is
SQLite-only, and the old `published_narratives.editor_draft_id` foreign key was
already removed without deleting or nulling the provenance column.

This sprint produces **almost no user-visible behaviour change**. The app, the
API, and the four kept tables keep their shape throughout. So this is deliberately
**not** a conventional QA suite. The question is not "does this feature behave
correctly for the user" — it is **"is it still the same system after I moved
it?"**

That shapes the document in three ways:

1. **Invariants dominate.** Most cases are before/after comparisons of counts and
   distributions, not user flows. They are cheap, they run in seconds, and they
   catch the failure mode that actually threatens this sprint: something quietly
   stops being produced and nothing throws.
2. **Real unit tests are concentrated in Phase 3.** The queue, leases, recovery,
   and backpressure are concurrency and crash-timing logic whose failures cannot
   be reproduced by hand. That is where the current pipeline's two silent leaks
   live, and it is the only part of this sprint that earns a genuine test suite.
   The news lane's `recoverStaleWork` tests are the standard to match.
3. **Destructive operations get their own gate.** The final cleanup drops eight tables.
   The `DROP` cases are pre-flight checks, not post-hoc verification — several
   must pass *before* the destructive command runs, and they are the only cases
   in this document that are ordered.

## How to read this document

- **TC ID** groups: `SNAP` (Phase 0 baseline snapshot), `DROP` (Phase 1
  destructive operations and their pre-flight gates), `MIGRATE` (Phase 2 local
  store parity), `QUEUE` (Phase 3 queue, leases, recovery, backpressure),
  `RESTRUCT` (Phase 4 restructure and rename), `RESEARCH` (Phase 5 batching and
  cost), `INV` (standing invariants, re-run at every phase boundary).
- **Priority** P0 = blocks the phase, P1 = should pass before the phase closes,
  P2 = worth knowing.
- **Type** names the test's character: Invariant, Unit, Integration, Data
  Safety, Regression, Observability, Cost.
- **Execution** is stated on every case and is one of:
  - `Automatable` — runs in CI with no human. Unit and static-analysis cases.
  - `Query` — a read-only SQL query against Supabase or the local store, run by
    hand or by script. Most `SNAP`, `INV`, and `DROP` cases.
  - `Manual` — needs a human to stop/start processes or inspect a running system.
- **Status** is Not Run for all cases; update per phase.
- Cases depending on an unresolved PRD open question carry an inline
  **Assumes:** line naming the reading they were written against.

**Ordering:** only the `DROP` group is order-dependent — its pre-flight cases
gate an irreversible operation. Everything else can run in any order at its
phase boundary.

---

## 1. Baseline Snapshot (`SNAP`) — Phase 0

These establish the numbers every later invariant compares against. They are
worthless if run late. **All `SNAP` cases must pass and their outputs be recorded
before any Phase 1 command executes.**

### TC-SNAP-001: Crown-jewel row counts recorded

**Priority:** P0 · **Type:** Invariant · **Execution:** Query · **Status:** Not Run

**Steps**
1. Record `count(*)` for `entities`, `entity_memories`,
   `published_narratives`, `entity_published_history`.
2. Store the results in the sprint log with a timestamp.

**Expected**
- Four numbers recorded and committed somewhere durable (not just a terminal
  scrollback).
- These become the reference for every `INV` case.

### TC-SNAP-002: Entity memory distribution by source and type recorded

**Priority:** P0 · **Type:** Invariant · **Execution:** Query · **Status:** Not Run

**Steps**
1. `select source, source_area, memory_type, count(*) from entity_memories group by 1,2,3`.
2. Record the full result.

**Expected**
- Distribution recorded, including the `source_marker` count broken out
  separately — that number is what TC-DROP-004 will delete, and TC-INV-002 will
  verify.

### TC-SNAP-003: Junk table row counts and sizes recorded

**Priority:** P0 · **Type:** Data Safety · **Execution:** Query · **Status:** Not Run

**Steps**
1. Record row count and on-disk size for all eight tables on the PRD's final drop
   list.

**Expected**
- Counts and sizes recorded.
- **This case answers PRD open question 2.** Its output decides the Phase 1
  truncate strategy: single-statement truncate for small tables, batched deletes
  for large ones on a constrained instance.

### TC-SNAP-004: Full backup of the four kept tables taken and restore-verified

**Priority:** P0 · **Type:** Data Safety · **Execution:** Manual · **Status:** Not Run

**Steps**
1. Export `entities`, `entity_memories`, `published_narratives`,
   `entity_published_history`.
2. Restore the export into a scratch database or local instance.
3. Compare row counts against TC-SNAP-001.

**Expected**
- Restore succeeds and counts match exactly.
- A backup that has never been restored is not a backup. This case exists
  because Phase 1 is irreversible and this is the only safety net.

---

## 2. Destructive Operations (`DROP`) — Phase 1

**Ordered group.** TC-DROP-001 through 003 are pre-flight gates and must pass
*before* any drop or truncate runs.

### TC-DROP-001: No app or API reader references any drop-list table

**Priority:** P0 · **Type:** Data Safety · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Search `packages/api`, `packages/shared`, and `apps` for references to every
   table on the drop list.
2. Exclude `docs/`, `README.md`, and migration files.

**Expected**
- Zero matches.
- Baseline established during investigation: the only non-collector references
  were in `README.md` and `docs/sources/polymarket-markets.md`. Any *new* match
  here blocks the drop and needs investigation.

### TC-DROP-002: `entity_memories.source_research_id` is not a foreign key

**Priority:** P0 · **Type:** Data Safety · **Execution:** Query · **Status:** Not Run

**Steps**
1. Inspect the column definition and constraints on
   `entity_memories.source_research_id`.

**Expected**
- Column type is `text`, with no foreign-key constraint to
  `polymarket_market_candidate_research` or any other table.
- This is the single fact the entire "drop is safe" argument rests on. If it has
  changed since the PRD was written, **stop** — dropping research rows would
  cascade into entity memories.

### TC-DROP-003: No kept table has a foreign key to a drop-list table

**Priority:** P0 · **Type:** Data Safety · **Execution:** Query · **Status:** Not Run

**Steps**
1. Enumerate every foreign key on the kept tables.
2. Identify any that reference a drop-list table.

**Expected**
- Zero links. Migration `20260730_published_narratives_drop_editor_draft_fk.sql`
  removed the former draft foreign key while retaining the provenance column.
- Any link is an unknown dependency and blocks the drop.

### TC-DROP-004: `source_marker` rows removed from `entity_memories`

**Priority:** P0 · **Type:** Data Safety · **Execution:** Query · **Status:** Not Run

**Steps**
1. Record the `source_marker` count (from TC-SNAP-002).
2. Delete rows where `memory_type = 'source_marker'`.
3. Re-count `entity_memories` total.

**Expected**
- `source_marker` count is now zero.
- Total `entity_memories` decreased by **exactly** the pre-delete
  `source_marker` count — no more, no less. A larger drop means the delete
  predicate caught real memories.
- Entity count (`entities`) is completely unchanged. `source_marker` rows have a
  null `entity_id`, so nothing should cascade.

### TC-DROP-005: `source_marker` schema constraint dropped

**Priority:** P1 · **Type:** Regression · **Execution:** Query · **Status:** Not Run

**Steps**
1. Drop the `CHECK (entity_id IS NOT NULL OR memory_type = 'source_marker')`
   constraint.
2. Attempt to insert a row with a null `entity_id`.

**Expected**
- Insert is rejected — every memory must now belong to an entity.
- The constraint that existed solely to permit pipeline exhaust is gone, and the
  schema now enforces the rule.

### TC-DROP-006: Junk tables truncated without touching kept tables

**Priority:** P0 · **Type:** Data Safety · **Execution:** Query · **Status:** Not Run

**Steps**
1. Truncate all eight drop-list tables using the strategy chosen from
   TC-SNAP-003.
2. Re-run TC-SNAP-001's counts.

**Expected**
- All eight retired tables at zero rows.
- `entities`, `published_narratives`, `entity_published_history` counts
  **identical** to TC-SNAP-001.
- `entity_memories` equals TC-SNAP-001 minus the `source_marker` count only.

### TC-DROP-007: Published narratives and draft provenance survive

**Priority:** P0 · **Type:** Data Safety · **Execution:** Query · **Status:** Not Run

**Steps**
1. After dropping `editor_drafts`, count `published_narratives`.
2. Compare `editor_draft_id` values with the pre-drop snapshot.

**Expected**
- `published_narratives` count unchanged from TC-SNAP-001 — nothing was deleted.
- Existing `editor_draft_id` provenance values are unchanged because the foreign
  key was removed before the obsolete Supabase table is dropped.

---

## 3. Local Store Parity (`MIGRATE`) — Phase 2

### TC-MIGRATE-001: Local news store satisfies the pipeline interface

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Run the `NewsStore` contract test suite against the local implementation.

**Expected**
- The SQLite implementation passes the contract.
- The production path uses `news/store.ts` and `news/sqlite-store.ts`; no
  Supabase news-store implementation or alternate worker entrypoint remains.

### TC-MIGRATE-002: No Polymarket collector code writes pipeline state to Supabase

**Priority:** P0 · **Type:** Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Search `packages/collectors/src/polymarket` and the Polymarket
   entity-manager for direct Supabase calls against drop-list tables.

**Expected**
- Zero matches. Baseline before migration was ~27 call sites.
- Supabase access from the pipeline is limited to the four kept tables.

### TC-MIGRATE-003: One Supabase write per finished item

**Priority:** P0 · **Type:** Integration · **Execution:** Manual · **Status:** Not Run

**Steps**
1. Run the pipeline over a small fixed set of markets.
2. Count Supabase write operations.

**Expected**
- Writes occur only at the entity-memory and narrative stage.
- Write count scales with *finished items*, not with items × stages. This is the
  behavioural definition of the migration succeeding.

### TC-MIGRATE-004: Local store survives process restart

**Priority:** P0 · **Type:** Integration · **Execution:** Manual · **Status:** Not Run

**Steps**
1. Start the pipeline, let it accumulate in-flight state.
2. Kill the process mid-run. Restart.

**Expected**
- Local store reopens with state intact.
- In-flight work is recoverable (see `QUEUE` group), not stranded.

### TC-MIGRATE-005: Local store backup produces a restorable file

**Priority:** P0 · **Type:** Data Safety · **Execution:** Manual · **Status:** Not Run

**Steps**
1. Run the backup routine.
2. Restore into a scratch location and open it.

**Expected**
- Restore succeeds and content matches.
- **This is the mitigation for the PRD's stated durability risk.** The VPS disk
  is not backed up; managed Postgres was. Without this case passing, Phase 2 is a
  net reduction in safety.

### TC-MIGRATE-006: Egress does not grow under sustained operation

**Priority:** P0 · **Type:** Cost · **Execution:** Manual · **Status:** Not Run

**Steps**
1. Record Supabase egress. Run the pipeline for a sustained period under normal
   load.
2. Record egress again.

**Expected**
- Growth is proportional to finished items only.
- No free-tier warning. This is the sprint's originating symptom and the most
  direct measure that Phase 2 worked.

---

## 4. Queue, Recovery, Backpressure (`QUEUE`) — Phase 3

**This is the one group that earns a genuine unit-test suite.** These failures are
concurrency and crash-timing bugs that cannot be reproduced by hand, and they are
where the current pipeline's two documented silent leaks live. Match the standard
of the news lane's `recoverStaleWork` tests.

### TC-QUEUE-001: Claimed work is leased, not silently flipped

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Claim a batch of work items.
2. Inspect their state.

**Expected**
- Each item carries a lease with an owner and an expiry.
- Contrast with current behaviour: `markCandidatesResearching` flips items to
  `researching` with no lease, no owner, and no expiry — which is exactly why
  they strand.

### TC-QUEUE-002: Expired leases return work to the queue

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Claim items. Advance time past lease expiry without completing them.
2. Run recovery.

**Expected**
- Items return to claimable state with an incremented attempt count.
- **This is the direct fix for the `researching` black hole.** Under today's
  code these items are invisible to the fetch query forever.

### TC-QUEUE-003: Crash mid-batch strands nothing

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Claim a batch. Simulate a process kill partway through.
2. Restart and run recovery.

**Expected**
- Every item is either completed or back in the queue.
- Zero items in a non-terminal state with no live lease.
- Covers the partial-flip throw path: today, a mid-loop failure in
  `markCandidatesResearching` leaves part of a batch permanently stranded.

### TC-QUEUE-004: Aged-out work gets a terminal status, not a silent filter

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Create work older than the age threshold.
2. Run the queue.

**Expected**
- Item receives an explicit terminal status and is countable.
- **This is the direct fix for the `maxCandidateAgeHours: 48` leak**, where items
  simply fall out of the query's `gte('observed_at', …)` filter and become
  invisible while remaining `pending_research` forever.

### TC-QUEUE-005: Retry cap is honoured and exhaustion is terminal

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Force an item to fail repeatedly past the retry cap.

**Expected**
- Attempts stop at the cap.
- Item lands in a terminal failed state, countable and visible — not retried
  forever and not silently dropped.

### TC-QUEUE-006: Concurrent runs do not double-claim

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Run two claim operations concurrently against the same queue.

**Expected**
- No item is claimed by both.
- Note: today's status-flip accidentally prevents double-claiming, but it is not
  a real lock and it is the mechanism that strands work. The replacement must be
  correct *and* recoverable.

### TC-QUEUE-007: Runner refuses overlapping ticks

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Trigger a run that takes longer than the tick interval.
2. Let the next tick fire.

**Expected**
- Second tick is skipped or queued, not run concurrently.
- Both `run-researcher.ts` and `run-polymarket.ts` currently use a bare
  `setInterval` with no in-flight guard, and a researcher run exceeding 5 minutes
  is entirely plausible.

### TC-QUEUE-008: Backlog above threshold throttles supply

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Seed the queue above the configured backlog threshold.
2. Run the collector.

**Expected**
- New candidate creation is throttled or paused.
- **This is the arithmetic fix.** Today the collector's ~125-per-2h and the
  researcher's 20-per-5min-sequential are unrelated constants; neither knows the
  other exists.

### TC-QUEUE-009: Material moves respect backpressure policy

**Priority:** P1 · **Type:** Integration · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. With backlog above threshold, present a material-move candidate.

**Expected**
- Behaviour matches the documented policy decision.
- Today `isMaterialCandidate` bypasses the `blocksCandidate` backlog check
  entirely. Whether material moves should still bypass under the new scheme is a
  **policy decision that must be made explicitly**, not inherited by accident.

### TC-QUEUE-010: Status endpoint reports per-stage backlog depth

**Priority:** P0 · **Type:** Observability · **Execution:** Manual · **Status:** Not Run

**Steps**
1. Seed known backlog depths. Query the status endpoint.

**Expected**
- Reported depth matches actual per stage.
- **This must land in Phase 3, not later.** Phase 2 removes the Supabase
  dashboard, which is currently the only way to see pipeline state. Without this,
  the sprint ends with less visibility than it started — and the originating
  symptom of this whole effort was a backlog nobody could see.

---

## 5. Restructure and Rename (`RESTRUCT`) — Phase 4

### TC-RESTRUCT-001: Full build and type check pass

**Priority:** P0 · **Type:** Regression · **Execution:** Automatable · **Status:** Not Run

**Expected**
- Clean build, no type errors, no unresolved imports after the rename.

### TC-RESTRUCT-002: Existing test suite passes unchanged in behaviour

**Priority:** P0 · **Type:** Regression · **Execution:** Automatable · **Status:** Not Run

**Expected**
- All tests pass. Renamed identifiers are updated; assertions are not weakened to
  accommodate the restructure.

### TC-RESTRUCT-003: No stale feed-era references remain

**Priority:** P1 · **Type:** Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Search for feed-era file names and identifiers targeted by the rename.

**Expected**
- Only intentional references remain (e.g. `published_narratives`, which is a
  kept table and out of scope for renaming).

### TC-RESTRUCT-004: Source adapters share one runner

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable · **Status:** Not Run

**Expected**
- Polymarket, news, and hyperliquid lanes route through a single shared runner.
- No lane carries its own copy of claim/retry/recovery logic. The duplication is
  precisely why the same silent-leak bug exists independently in each lane today.

### TC-RESTRUCT-005: Egress guard still holds

**Priority:** P0 · **Type:** Regression · **Execution:** Automatable · **Status:** Not Run

**Expected**
- `egress-guards.test.ts` passes, or its intent is preserved in whatever replaces
  it after the restructure.
- The `related_context` fix must not be silently undone by the rename. If the
  guard's target tables have moved local, the test should be updated
  deliberately, not deleted.

---

## 6. Research Batching and Cost (`RESEARCH`) — Phase 5

### TC-RESEARCH-001: Baseline research cost per candidate measured

**Priority:** P0 · **Type:** Cost · **Execution:** Manual · **Status:** Not Run

**Steps**
1. Over a fixed candidate set, record calls made, wall-clock time, and token
   spend per candidate.

**Expected**
- Baseline recorded before any batching change. Without it, "measurably lower"
  in the PRD's success criteria is unfalsifiable.

### TC-RESEARCH-002: Depth-path distribution measured

**Priority:** P0 · **Type:** Cost · **Execution:** Query · **Status:** Not Run

**Steps**
1. Record the fraction of candidates classified `deep_web` vs `reuse_prior` vs
   `market_structure_only`.

**Expected**
- Distribution recorded.
- **This is the number that should decide how much Phase 5 effort is worth.** If
  the expensive `deep_web` path is rare, batching matters less than expected and
  the investment should shift. Run this before building.

### TC-RESEARCH-003: Clustered candidates share a single research call

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Present multiple candidates that resolve to the same cluster key.

**Expected**
- One research call covers the cluster.
- `researchDeepWebCandidates` already groups by cluster key and then discards the
  grouping to process one at a time. The grouping exists; only the batching is
  missing.

### TC-RESEARCH-004: Batched research produces per-candidate results

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable · **Status:** Not Run

**Expected**
- Every candidate in a batch gets its own research row.
- No candidate is silently dropped because a sibling in its batch succeeded or
  failed. Batching must not create a new silent-loss path — that is the exact
  bug class this sprint exists to eliminate.

### TC-RESEARCH-005: Partial batch failure does not fail the whole cluster

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable · **Status:** Not Run

**Expected**
- Successful members are written; failed members are retried or terminally
  marked individually.

### TC-RESEARCH-006: Cost per candidate improved against baseline

**Priority:** P0 · **Type:** Cost · **Execution:** Manual · **Status:** Not Run

**Expected**
- Measured cost per candidate is lower than TC-RESEARCH-001, over the same
  fixed set.

---

## 7. Standing Invariants (`INV`) — every phase boundary

Re-run all of these at the close of every phase. They are the regression suite
for a sprint whose main risk is **silent** loss, not loud failure.

### TC-INV-001: Entity count never decreases unexpectedly

**Priority:** P0 · **Type:** Invariant · **Execution:** Query · **Status:** Not Run

**Expected**
- `entities` count is greater than or equal to the previous boundary's count.
- Any decrease is investigated before proceeding. Nothing in this sprint should
  ever delete an entity.

### TC-INV-002: Entity memory count changes only as predicted

**Priority:** P0 · **Type:** Invariant · **Execution:** Query · **Status:** Not Run

**Expected**
- The only sanctioned decrease across the whole sprint is the Phase 1
  `source_marker` deletion, equal to the count from TC-SNAP-002.
- Any other decrease is a defect.

### TC-INV-003: Memories continue to accumulate while the pipeline runs

**Priority:** P0 · **Type:** Invariant · **Execution:** Query · **Status:** Not Run

**Expected**
- With the pipeline running, `entity_memories` grows over time.
- **This is the single most important case in the document.** The realistic
  failure mode of this sprint is not a crash — it is the pipeline quietly
  producing nothing while every process reports success. A flat count with
  healthy-looking logs is the signature.

### TC-INV-004: Source distribution stays proportional

**Priority:** P1 · **Type:** Invariant · **Execution:** Query · **Status:** Not Run

**Expected**
- Per-source, per-type memory distribution stays roughly proportional to
  TC-SNAP-002's baseline.
- A source dropping to zero while others continue means that lane broke — the
  failure a total count alone would hide.

### TC-INV-005: No work item sits non-terminal beyond one recovery interval

**Priority:** P0 · **Type:** Invariant · **Execution:** Query · **Status:** Not Run

**Expected**
- Zero items in a claimed or in-progress state older than one recovery interval.
- Directly restates the PRD's success criterion and is the standing check against
  regression to the stranding behaviour.

### TC-INV-006: App-facing reads still work

**Priority:** P0 · **Type:** Regression · **Execution:** Manual · **Status:** Not Run

**Expected**
- Entity, memory, and narrative reads through the API return data as before.
- The four kept tables keep their shape; nothing in this sprint should change the
  app's view of the world.

---

## Open questions and ambiguities

Carried from the PRD. Each names the cases that depend on it.

1. **`editor_draft_id` provenance** — resolved. The foreign key is gone and the
   text value stays unchanged when the obsolete remote table is dropped.
2. **Row counts and sizes** (PRD open question 2) — TC-SNAP-003 produces this.
   It determines the TC-DROP-006 truncate strategy and the Phase 2 scope.
3. **`source_marker` count** (PRD open question 3) — TC-SNAP-002 produces this.
   TC-DROP-004 and TC-INV-002 both depend on the exact number.
4. **News and Hyperliquid lanes** — resolved. News temporary state is local
   SQLite; Hyperliquid tables are retained and outside this cleanup.
5. **Blackout window** — the PRD says each phase leaves the pipeline green, but
   Phase 1 stops the collectors and they stay stopped until Phase 3 completes.
   TC-INV-003 and TC-INV-004 **cannot run during that window**. This needs an
   explicit decision: accept a dark middle and verify only at the Phase 3
   boundary, or keep a thin slice of the pipeline live (one tag, a handful of
   markets) so there is always a signal. Recommendation: keep a slice live — a
   two-phase blackout across the riskiest work is where silent surprises
   accumulate.
