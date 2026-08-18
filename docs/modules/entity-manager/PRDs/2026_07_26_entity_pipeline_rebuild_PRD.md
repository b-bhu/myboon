# Entity Pipeline Rebuild PRD

Status: draft for review
Date: 2026-07-26
Owner: myboon pipeline
Module: entity-manager
Branch: `pipeline/entity-core-rebuild`
Scope: Polymarket lane end-to-end, with shared spine used by all sources
Test cases: [`2026_07_26_entity_pipeline_rebuild_test_cases.md`](../test%20cases/2026_07_26_entity_pipeline_rebuild_test_cases.md)

## Purpose

Rebuild the signal pipeline so that intermediate pipeline state lives on the VPS,
Supabase holds only the entity core, and the expensive research step becomes the
place we invest engineering time rather than the place we lose it.

Today the pipeline is six independent processes, each on its own timer, each
polling a shared hosted database to ask "is there anything for me?" Most of the
time the answer is no, and we paid for the question. When a process picks up work
and dies, that work is stranded silently with no retry and no alarm.

```text
current
  collector (2h)   -> supabase candidates
  researcher (5m)  -> supabase research
  editor (1h)      -> supabase decisions + drafts
  entity-manager   -> supabase entity_memories
  publisher (5m)   -> supabase published_narratives

target
  collector -> local queue
  researcher -> local queue      (all intermediate state on VPS)
  editor -> local queue
  entity-manager -> SUPABASE     (single durable write per finished item)
  publisher -> SUPABASE
```

The pipeline has been stopped for roughly ten days pending this rethink. It is
not being restarted on the current design.

## Problem

Three compounding problems, all visible in the code today.

**Cost.** Six workers poll a hosted database forever. Free-tier egress has hit a
warning. The `related_context` fix and the `egress-guards.test.ts` guard were the
right call, but they defend the boundary by hand, per column, per query, with a
test that has to be remembered. Nothing structural prevents the next regression.

**Work disappears silently.** `markCandidatesResearching` flips a batch to
`researching` before any work happens. Nothing ever recovers those rows — the
fetch query only looks at `pending_research` and `research_failed`. Any crash,
restart, or mid-run throw strands the batch permanently. Separately,
`maxCandidateAgeHours: 48` drops older candidates out of the query filter with no
terminal status, so they sit `pending_research` forever, invisible. Two silent
sinks, and the same class of bug is reimplemented independently in each source
lane. The news lane already solved it (`recoverStaleWork`); Polymarket never got
that treatment.

**Throughput cannot keep up with supply, by arithmetic.** The collector can
produce ~125 candidates every 2h. The researcher takes 20 every 5 min but
processes them strictly one at a time, and a worst-case `deep_web` item costs up
to ~11 minutes (2 Hermes calls at 60s + 2 retrieval passes at 5 min each). The
two numbers are unrelated constants that do not know the other exists. Backlog
growth is the designed behaviour, not a defect.

## What is crown jewels and what is junk

Verified against the schema and every call site.

**Final keep boundary (Supabase, confirmed 2026-08-18):**

- `entities`
- `entity_memories`
- `published_narratives`
- `entity_published_history`
- `pipeline_runs`
- `polymarket_catalog_*`
- Hyperliquid tables
- `pacific_tracked`
- migration history and unrelated application tables

The first four are durable product data. The other retained tables are still
active infrastructure or belong to a different collector and are explicitly
outside this cleanup.

**Final drop list:** `polymarket_market_candidates`,
`polymarket_market_candidate_research`, `polymarket_market_editor_decisions`,
`polymarket_market_watchlist`, `editor_drafts`,
`news_candidate_observations`, `news_research_results`, and `news_source_runs`.

This final boundary supersedes the broader draft drop list. In particular,
`pipeline_runs` and Hyperliquid tables are kept.

**Why the drop is safe:** `entity_memories.source_research_id` is a plain `text`
column, not a foreign key. Deleting research rows orphans nothing and cascades
nowhere. The Polymarket adapter copies evidence links and summaries *into* the
memory row at write time (`polymarket-adapter.ts:97-129`), so memories are
self-contained.

**Resolved dependency:** migration
`20260730_published_narratives_drop_editor_draft_fk.sql` already removed the
foreign key from `published_narratives.editor_draft_id` to `editor_drafts`.
The text column remains as cross-database provenance for locally stored drafts,
so dropping the obsolete Supabase draft table neither nulls nor deletes durable
narratives.

**Pollution to clean:** the Polymarket entity-manager writes bookkeeping rows
into `entity_memories` as `memory_type: 'source_marker'`, titled
`entity_manager:processed` / `entity_manager:failed`, purely to remember what it
already handled. It then pages through up to 50 pages of research rows every 5
minutes cross-checking against them (`run-polymarket.ts:118-140`). This is
pipeline state inside the crown jewels, and the schema constraint
`CHECK (entity_id IS NOT NULL OR memory_type = 'source_marker')` exists solely to
permit it.

## Plain-language walkthrough

This section explains the whole sprint without technical vocabulary, one entry
per GitHub issue, in execution order. It exists so the sprint can be reviewed and
steered by someone who is not reading the code. Everything below is restated
technically in the Phases section.

### The situation, in one paragraph

We have a factory with five workstations. Raw material comes in (market signals),
gets researched, edited, turned into entities, and published. The problem is that
nobody built a conveyor belt between the stations. Each worker checks a shared
bulletin board every few minutes asking "anything for me?" — and when a worker
picks up a job and drops it, that job is gone. Nobody notices. That is the entire
sprint: build the conveyor belt, throw out the pile of dropped jobs, and then make
the expensive station faster.

### #253 — Count everything before we touch anything

**What we are doing:** Writing down exactly what is in the database today. How
many entities, how many memories, where they came from. Then taking a backup and
*actually restoring it* to prove the backup works.

**Why it matters:** The cleanup deletes eight tables permanently. If something
goes wrong, these numbers are the only way to know. A backup nobody has tested is
not a backup — it is a hope.

**The real reason this is first:** The way this sprint fails is not a crash. It is
the pipeline quietly producing nothing while every dashboard says "healthy." No
errors, no alarms, entities just stop appearing. The only way to catch that is to
know what normal looked like beforehand.

**Tucked in here:** we also measure how many market signals take the expensive
research path versus the cheap ones. That number could change the shape of the
last issue in this sprint, so we want it in week one.

**Input needed:** none. Pure measurement.

### #254 — Throw out the junk

**What we are doing:** Deleting eight database tables. All of it is scratch work
— notes the pipeline made to itself while producing entities. The app has never
read a single row of it.

Also cleaning something out of the good data: the pipeline has been scribbling
sticky notes into the entity memory table ("already processed this one," "this one
failed"). Bookkeeping, filed in the same drawer as the actual product. We remove
those and change the rules so it cannot happen again.

**Why it matters:** This is what drives the database bill. And the sticky notes
are worse than clutter — every five minutes the pipeline flips through hundreds of
pages of records cross-checking against them, rifling through the most valuable
table to do it.

**The safety part:** Three checks run *before* anything is deleted, bundled into
the same issue deliberately so the deletion cannot happen without them. The
important one: entity memories do not actually depend on any of the junk — they
carry their own copy of the evidence. We re-verify at execution time, because if
that changed since we looked, deleting would cascade into real data.

**Input needed:** one real decision. There is a link between published stories and
the editor drafts they came from. Delete the drafts and that link goes blank — the
stories are untouched, but the "which draft produced this" trail is lost. Reading:
acceptable, drafts are scratch. But it is the one item here that is not purely
junk.

### #255 — Build the new filing cabinet

**What we are doing:** Building a local database on our own server to hold the
pipeline's working notes. Nothing gets connected to it yet — we build and test it
while the old system keeps running.

**Why it matters:** All five workstations run on the same machine. Today they
coordinate by sending messages to a database in another country and waiting for
replies. Thousands of round trips a day for conversations that could happen in the
same room. That is the bill.

**Why it is separate:** Building the cabinet and moving files into it are two
different risks. Doing both at once means a break could be either. This issue
changes nothing that is running.

**The honest tradeoff:** Managed databases back themselves up; our server's disk
does not. So a backup routine is part of this issue, not a follow-up — otherwise
we would be trading a bill for a risk.

**Input needed:** agreement that pipeline scratch data can live somewhere with
less automatic protection than today. It regenerates, so this is reasonable — but
it is a real change.

### #256 — Move in

**What we are doing:** Rewiring about 27 places in the code so the pipeline reads
and writes locally. After this it talks to the hosted database exactly once per
finished item, instead of continuously at every step.

**Why it matters:** This is the issue where the bill actually drops. Everything
before it is preparation. Success is measured simply: run the pipeline and watch
whether the usage warning returns.

**Side effect:** the sticky notes from #254 were how the pipeline remembered its
place. Now it keeps a proper bookmark locally, so the "flip through hundreds of
pages every five minutes" behaviour disappears entirely.

**Input needed:** whether the other two sources (news, perps) move now or later.
Recommendation: later — let Polymarket prove the pattern first.

### #257 — Stop losing work

**What we are doing:** Replacing "check the bulletin board on a timer" with a real
job queue. Jobs get checked out with a name and a deadline. If a worker dies
mid-job, the deadline passes and the job returns to the pile automatically.

**Why it matters — this is the originally observed bug.** Two ways work vanishes
today. First: when a worker picks up 20 jobs it marks all 20 "in progress" before
doing anything; if it crashes, those 20 stay marked forever and nothing ever looks
at them again. Not failed, not pending — invisible. Second: anything older than 48
hours silently stops being eligible. It is not marked expired; it just stops
showing up in searches while still saying "waiting."

Neither is broken code. The code does exactly what it says. It simply never had a
way to un-lose things.

**Worth knowing:** the news pipeline already solved this correctly, with tests.
The Polymarket side never got the same treatment. This brings it to that standard.

**Why this gets real tests when most of the sprint does not:** crash recovery
cannot be verified by clicking around. You have to simulate the crash.

**Input needed:** none. This is the least negotiable issue — skipping it means
rebuilding everything and keeping the original bug.

### #258 — Make the two sides talk, and make it visible

**What we are doing:** Two things. The collector checks how big the backlog is
before creating more work, and eases off when it is deep. And a status page shows
how much work is waiting at each stage.

**Why it matters:** The collector can produce about 125 items every two hours. The
researcher handles them one at a time, and a hard one takes up to 11 minutes.
Neither number knows the other exists — they were set independently. The backlog
is not a malfunction, it is arithmetic.

**Why the status page is bundled in:** throttling you cannot see is unmergeable —
there would be no way to tell whether it is protecting the pipeline or quietly
starving it. Sharper reason: #256 removes the database dashboard, currently the
only way to peek at pipeline state. Without this, the sprint ends with *less*
visibility than it started, which given that an invisible backlog started this
whole effort would be a bad joke.

**Input needed — this one genuinely requires a decision.** There is a rule today
that says "do not create new work if there is already unfinished work on this
topic." It has an exception: if a market moves significantly, it skips the rule
and creates work anyway. That exception is why the backlog grew despite the
safeguard existing. Should big moves still skip the queue? For: a genuine market
move is time-sensitive and missing it means missing the story. Against: bursts of
big moves are exactly when the backlog explodes. This is a product judgment about
what the feed is for.

### #259 — Rename things to match reality

**What we are doing:** Reorganising the code around entities, and renaming
everything still called "feed."

**Why it matters:** When this started, the product was a feed built from sources.
It is now an entity system, and the feed is a byproduct — the content team reads
entities and writes from them. The code still has the old worldview in its
structure: three separate copies of nearly identical machinery, one per source.

That duplication is not cosmetic — it is *why* the same bug existed in multiple
places. News got the fix, Polymarket did not, because they are separate
implementations of the same thing.

**Note:** the only lower-priority issue. Real value, but cleanup rather than
repair. If time gets tight, this is the one to slip.

**Input needed:** naming preferences, if any.

### #260 — Make research cheaper and better

**What we are doing:** Today every market gets its own research call. Ten markets
about the same election means ten separate calls asking overlapping questions. We
batch related ones together.

**The maddening detail:** the code *already* groups related markets — then throws
the grouping away and processes them one at a time anyway. The hard part is done;
it just is not used.

**Why it matters most:** this is simultaneously the biggest AI cost and the reason
the backlog forms. Same fix, both problems. This is the issue that was actually
wanted — everything before it is groundwork to make research cheap and safe to
change.

**What to guard hardest:** batching is a natural place to accidentally reintroduce
"work silently disappears" — one item fails and takes its neighbours down quietly.
Given that is the exact bug class this sprint exists to kill, it gets explicit
attention.

**Input needed:** once research is cheap, what should it do better? More sources?
Deeper evidence? That is the conversation this sprint buys.

### Two things to decide

**The blackout.** From #254 through #258 the pipeline is off. That is the riskiest
stretch of work happening while the two checks that detect silent failure cannot
run. Recommendation: keep one small slice alive — a single tag, a handful of
markets — so there is always a heartbeat. It costs a little scope in #254 and #256
and it is worth it. **This is the main thing to decide before starting.**

**The order is deliberate.** Clean up, then repair, then improve. Each stage makes
the next cheaper. The temptation when things run long is to jump ahead to #260
because it is the interesting one — but it sits on top of everything else, so it
would be building on sand.

## Goals

- Supabase holds the entity core and nothing else.
- All intermediate pipeline state lives in one local store on the VPS.
- No work item can be stranded without a terminal status or an alarm.
- Backlog depth is bounded and visible per stage.
- One shared runner replaces four near-identical per-source implementations.
- Research depth becomes cheap to iterate on — that is the point of the sprint.

## Non-Goals

- Do not prune low-value odds-fluctuation memories from `entity_memories` in this
  sprint. Same table, separate judgment calls, tracked as follow-up below.
- Do not migrate the news or hyperliquid lanes in Phase 2 until Polymarket proves
  the pattern.
- Do not add new research capability before measuring what current research costs.
- Do not change the app or API surface. The four kept tables keep their shape.
- Do not restart the current pipeline design.

## Phases

Each phase must leave the pipeline green before the next begins. Phases 2 and 3
are the risky pair and must not be done together — a break should be attributable
to one of them, not either.

### Phase 0 — Decide and record

- Confirm drop list and keep list in writing, including the `editor_draft_id`
  decision.
- Snapshot `entities`, `entity_memories`, `published_narratives`,
  `entity_published_history` before anything is deleted.
- Capture row counts and table sizes for all tables (open question below).

### Phase 1 — Clear the decks

- Truncate all pipeline working tables; keep the four crown-jewel tables.
- Delete `source_marker` rows from `entity_memories`.
- Drop the `entity_id IS NOT NULL OR memory_type = 'source_marker'` constraint.
- Collectors stay stopped until Phase 3 completes.

Truncate strategy depends on row counts. Small tables: single statement. Large
tables on a constrained instance: batched deletes, to avoid lock duration and
timeout risk.

### Phase 2 — Move pipeline state off Supabase

- One local store on the VPS owns candidates, research, decisions, drafts, and
  run logs.
- Follow the existing `NewsStore` interface pattern (`news/store.ts` and
  `news/sqlite-store.ts`) rather than inventing a new abstraction. The retired
  Supabase implementation was removed after the SQLite cutover. Polymarket
  originally called Supabase directly from ~27 sites.
- Supabase writes happen once per finished item, not continuously.
- Backup routine for the local database. The VPS disk is not backed up and this
  is a real durability change from managed Postgres.

### Phase 3 — Fix the pipeline spine

- Replace timer-polling with a queue: leases, retries, crash recovery, terminal
  statuses. No work item can vanish.
- Recovery for stranded in-progress work, matching the news lane's
  `recoverStaleWork`.
- Aged-out candidates get an explicit terminal status instead of falling out of a
  query filter.
- Bound backlog depth per stage; supply throttles when the queue grows. Requires
  the collector and researcher to be aware of each other, which today they are
  not.
- Overlap guard on every runner. `run-researcher.ts` and `run-polymarket.ts` both
  use a bare `setInterval` with no in-flight mutex.
- Status endpoint exposing per-stage backlog depth, replacing the Supabase
  dashboard we lose in Phase 2.

### Phase 4 — Restructure and rename

- Reorganize around entities. Sources become thin adapters over one shared
  pipeline, instead of four parallel implementations of the same logic.
- Rename feed-era files and terminology to entity-era. The project began
  source-centric and named everything "feed"; the model is now entity-centric and
  feed is a byproduct. The naming is the last artifact of the old worldview.
- Delete dead code the restructure exposes.

Rename lands with the restructure, not as a separate pass — the two touch the
same files and splitting them doubles the review burden.

### Phase 5 — Research investment

This is the point of the sprint. Phases 1–4 exist to make this phase cheap and
safe to iterate on.

- Batch related markets into a single research call. `researchDeepWebCandidates`
  already groups candidates by cluster key, then discards the grouping and
  processes one at a time (`researcher.ts:1740-1752`). This is the largest cost
  line and the throughput ceiling — one fix, both wins.
- Measure what fraction of candidates take the expensive `deep_web` path versus
  the cheap `reuse_prior` / `market_structure_only` paths before adding depth.
- Then add capability: better retrieval, stronger evidence, more sources.

## Risks

**Durability.** Managed Postgres backs itself up; a VPS disk does not. In-flight
pipeline state becomes losable. Acceptable for regenerable scratch data, but it
requires a backup routine and a documented rebuild answer — a conscious decision,
not a shrug.

**Visibility.** We lose the Supabase dashboard for inspecting pipeline state.
Mitigated by the Phase 3 status endpoint, which must land in the same phase.

**Migration scope.** ~27 Polymarket call sites talk to Supabase directly. The
abstraction has to be right or we get a half-migrated mess. The `NewsStore`
pattern reduces this risk substantially but does not remove it.

**Sequencing.** Doing Phase 2 and Phase 3 together makes failures unattributable.
Strict ordering, green pipeline between each.

## Open questions

1. **`editor_draft_id` provenance** — resolved by the 2026-07-30 migration:
   keep the column but remove its cross-database foreign key.
2. **Row counts and table sizes** — not yet measured. Sizes the Phase 1 truncate
   strategy and scopes Phase 2. If candidates and research dominate, a
   Polymarket-only migration captures most of the benefit and news/hyperliquid
   can wait. If load is spread evenly, partial migration leaves most of it in
   place.
3. **`source_marker` row count in `entity_memories`** — how polluted the crown
   jewels currently are.
4. **News and hyperliquid lanes** — migrate in this sprint, or after Polymarket
   proves the pattern? Recommendation: after.

## Follow-ups (explicitly out of this sprint)

- Prune low-value odds-fluctuation memories from `entity_memories`. Noted here
  because it touches the same table. Worth flagging: these memories exist partly
  because the collector flags every material odds move as research-worthy. Phase
  3 backpressure and Phase 5 triage should slow the creation rate going forward,
  which changes the shape of that cleanup.

## Success criteria

- Supabase contains four tables related to this pipeline; no pipeline working
  state.
- No egress warning under sustained pipeline operation.
- Zero work items in a non-terminal state older than one recovery interval.
- Backlog depth per stage visible on demand and bounded under normal load.
- Research cost per candidate measurably lower than the current
  one-call-per-market baseline.
