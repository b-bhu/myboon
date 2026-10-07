# 7 October — article pipeline recovery

This work repairs the News article path through Entity Manager. It adds no
downstream reader, consumer, API, UI or publishing integration. The existing
Editor and Publisher services continue using their existing publication path.

## Failures reproduced

The morning News queue contained 140 dead letters and no pending or retry work
(47 source-bound failures, 44 candidate-input failures, 17 entity-resolution
failures, 24 retrieval failures, five synthesis/limit failures and three
classification timeouts).
There were 82 unresolved paid reservations. These are overlapping views of
retained work, not another 82 failed articles. Process `online` therefore did
not mean that Research was making progress.

- The GRASS bandwidth-sharing article had a saved, untruncated 26,215-character
  capture. The former 16,000-character decision bound rejected it before Jev or
  Hermes ran. Its work ID is `work_cc0e5347fbaf4f6311e3bea9d97aa7cf`.
- Candidate summaries exceeded Jev's placement input field, or were empty
  strings rather than absent descriptions. The full entity profile belongs in
  storage; the decision description needs its own projection.
- The Monad Robinhood article redirected from `www.monad.xyz` to `monad.xyz`.
  The reviewed publisher alias was missing from the retained-domain policy.
- The White House article resolved to public `192.0.66.51`. The IPv4 check
  incorrectly blocked the entire `192.0.*.*` range. IANA's special-purpose
  registry assigns `192.0.0.0/24` and `192.0.2.0/24` here, rather than that whole
  range. [Primary registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml).
- Local classification validation ran after a paid dispatch intent was saved.
  That made some input errors appear to be unknown paid outcomes. Received but
  rejected responses also needed a distinct durable outcome.
- Primary and related historical duplicates could nominate different items,
  producing a shared-target conflict even when the primary exact match was
  resolved.

## Implementation

Source admission is now **48,000 characters**, retaining the entire capture.
The serialized Jev state remains bounded to **96,000 UTF-8 bytes**. Over-limit
inputs hold explicitly; there is no source truncation or web-search fallback.
The source bound is shared by placement, relationships, novelty and the
source-grounded entity-proposal path.
New entity proposals bind 16,000 input and 2,000 output token limits into the
actual Hermes request. Older reservations retain their recorded limits and
attempt identity.

Jev receives candidate descriptions of at most 1,000 characters, with explicit
excerpt markers. Empty descriptions become `null`. Full catalogue summaries
and source text remain unchanged in storage and in the durable handoff.
Historical title projections are bounded to 500 characters and identify
missing titles explicitly; historical IDs, origins and stored prose remain
unchanged.

Classification preflight now precedes paid reservation/dispatch intent.
Confirmed received-but-rejected responses are retained as rejection receipts
and settle the exact attempt. Recovery checks the receipt before considering
another dispatch. A genuine unknown transport outcome stays held under the
same reservation. This applies to classification, primary prose, entity
proposals and bounded follow-up; it does not enable the older follow-up feature.

For `already_known`, one primary exact duplicate owns the shared reuse effect.
Secondary exact matches are retained as `contextualDuplicateTarget`, together
with their raw Jev decisions and prior-item references. They cannot merge items
or authorize another attachment target. A related-only duplicate cannot
suppress a new primary development. Existing immutable source checkpoints and
legacy cross-entity reuse protections remain authoritative.

URL checking retains DNS screening, pinned connections, private-address blocks
and approved redirect policy. The only new publisher alias is the reviewed
Monad `www` → apex redirect. Actual HTTP probes returned 200 for Monad and the
White House. A PANews example still returned an upstream 502; this is not
reported as a repaired source-availability failure.

## Admission policy and retained history

All 82 historical unknown paid outcomes remain retained. Existing audit rows
and zero/default usage counters do not prove that a paid dispatch never
happened, so this run does not release them or replay those jobs.

News-only runtime overrides are `FEED_V3_TRIAGE_P3_CAPACITY=200` and
`FEED_V3_TRIAGE_LIGHT_CAPACITY=200`. Defaults remain 100; accepted overrides are
integers from 1 through 500. The override retains unresolved exposure in the
capacity calculation. P0/P1 reservations, P2, standard/deep capacity and each
assignment's paid-call/token limits are unchanged. This creates bounded room
for fresh work instead of making historical unknown outcomes disappear.

This is a temporary, explicit operating policy. At the next morning review,
compare active work plus unresolved exposure with the original 100-slot
capacity and its 75% low-priority defer threshold. Remove both overrides
together only when that accounting supports continued admission. Reconcile
old paid outcomes only using authoritative matching proof; do not reset roots
or allowances. No automatic deferred-signal reconsideration was added.

Light-only Phase 1 remains enabled. Standard-depth deferrals are an existing
capability/policy exclusion, not a new web-search requirement introduced here.
Polymarket remains collection-only for this checkpoint.

## Verification and activation

Host-local private evidence lives under
`packages/collectors/.data/backups/pipeline-recovery-20261007/` and
`/tmp/myboon-pipeline-recovery-20261007/`; these are operational receipts, not
the only portable handoff. Credentials and private prompts are excluded from
Git.

The existing News backup/verification/restore helpers produced a verified
1,469,911,040-byte backup and a verified restored copy. Original source-file
size and modification time stayed unchanged during the stopped-source backup.
Three explicitly selected, still-fresh jobs—GRASS, Monad and White House—had no
unresolved paid attempt and were recovered through the canonical audited
operator. Saved captures, attempt counts, deadlines and allowances were not
reset. This was not a historical bulk replay.

`myboon-api` is protected throughout: PID `1719088`, restart count `1`, uptime
`1791000387540`. Repository updates do not imply that its running process has
loaded the newer API source. No API restart or API verification is part of this
task.

### Affected checks

All commands run from `packages/collectors/`. No repository-wide suite,
repository-wide TypeScript check, API test or UI/device check was run. This is a
backend pipeline repair; there is no UI deliverable in this boundary.

| Check | Result |
| --- | --- |
| URL safety regressions | Reproduced two failures before the fix; nine tests pass after the fix. |
| Placement, prose/proposal, context, persistence and capacity group | 50 pass. |
| Classification gateway/definitions and durable worker group | 49 pass. |
| Final persistence checks after the immutable-checkpoint guard | Six pass. |
| Isolated PostgreSQL article persistence | Seven pass, no skips; real TLS, restricted roles and disposable fixture database. |
| Collectors `tsc --noEmit -p tsconfig.json --pretty false` | Pass. |
| `git diff --check` | Pass. |

The persistence groups overlap; do not sum these counts into unique coverage.
The first isolated run exposed a new fixture expectation that said `reused` on
receipt-first replay; the established replay result is `written`. After fixing
that expectation, the group passed with unchanged production replay behavior.
Independent agents also caught and repaired a contract-invalid secondary
duplicate representation and a crash gap between rejection receipt and
settlement before activation.

Reproducible affected groups:

```bash
pnpm exec tsx --test src/news/tests/safe-public-http.test.ts
pnpm exec tsx --test src/research-engine/article-placement.test.ts src/research-engine/structured-synthesizer.test.ts src/research-gate/managed-context-reader.test.ts src/entity-manager/article-persistence.test.ts src/signal-platform/local-capacity.test.ts
pnpm exec tsx --test src/inference-gateway/classification-gateway.test.ts src/inference-gateway/classification-definitions.test.ts src/research-engine/v4-shared-worker.test.ts
ENTITY_V4_RUN_POSTGRES_TESTS=1 pnpm exec tsx --test src/entity-manager/article-persistence.integration.test.ts
pnpm exec tsc --noEmit -p tsconfig.json --pretty false
```

The gated PostgreSQL harness creates and removes its own internally networked
`postgres:17.11` fixture. It does not accept a production database URL. Docker,
the cached image and the harness's documented local privileges are required.
Tests alone do not authorize starting production services on another host.

### Real pipeline outcome

All six non-API services restarted. At **07:38:44 UTC / 13:08:44 IST**, all seven
PM2 entries were online; the API identity was unchanged. The six restarted
services had no stderr growth during this run. PM2's process list was saved
with private file permissions.

| Service | PID | Observed result |
| --- | ---: | --- |
| News ingestor | 2329359 | 36 fresh work admissions; retained unknown calls still counted. |
| Shared Research | 2329305 | Real Jev decisions and Ollama-authored article packets completed. |
| Shared Entity Manager | 2329246 | Accepted private receipts and source-preserving items. |
| Polymarket collector | 2324885 | Successful collection run; Research/Entity disabled. |
| Publisher | 2325103 | Successful existing-path runs; zero drafts available at the sampled runs. |
| Editor Draft | 2325261 | Successful existing-path run; zero eligible bundles at the sampled run. |

Canonical News had four completed jobs since the restart, including all three
recovered examples, zero new dead letters, 137 retained dead letters and 82
unchanged historical unknown paid reservations. Additional fresh work was
pending or leased. This is a dated smoke observation, not an overnight soak or
a claim that the historical backlog has been cleared.

| Recovered example | Accepted item | Full captured characters | Accepted at UTC |
| --- | --- | ---: | --- |
| GRASS bandwidth sharing versus surveys | `1b868f53-78f3-5a19-a941-5e00e87f2ce1` | 26,215 | 07:36:33 |
| Monad MON trading on Robinhood | `a4c89f7b-8808-57f1-a20e-cf04eed05d40` | 1,014 | 07:35:34 |
| White House German American Day message | `f2a08db3-fbad-5f2b-90ea-23cee08a65b0` | 2,014 | 07:37:02 |

All three canonical work rows are `complete`. Their actual packets identify
`ollama-cloud / glm-5.3-flash`, `fallbackUsed=false`, `truncated=false`, and no
formal claim/evidence arrays. PostgreSQL captured-text hashes match the SQLite
packets. The GRASS packet text also exactly matches the original pre-recovery
capture in the verified backup. Its hash is
`c55b0abcab27cab9181301a8ce50ae592f802bfd395846873ffb69545fd35405`.
Monad has two memberships, Monad primary and Robinhood related, on one item.

The Editor's earlier 05:13 UTC legacy-read statement timeout was retained in
logs; subsequent scheduled runs and this restarted run succeeded. No downstream
reader changes were made to hide that transient failure.

Remaining limitations: unavailable upstream pages, captures beyond the new
bounds, ambiguous identities/history, received invalid model output and genuine
transport uncertainty still produce explicit failures or holds. The historical
137 dead letters and 82 unknown paid outcomes were not erased. Old unnormalized
multi-target packets receive an immutable-checkpoint hold rather than a rewritten
source. Broad Jev placement accuracy, editorial quality and a full overnight
soak remain separate evaluation work.
