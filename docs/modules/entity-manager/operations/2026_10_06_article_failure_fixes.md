# Article failure fixes — implementation and verification

Date: 6 October 2026. Scope ends at Entity Manager; no downstream or API work.

Later update: the migration and runtime fixes were activated at the owner's request. See the [operational cleanup and overnight baseline](2026_10_06_operational_cleanup_and_overnight_baseline.md) for the current operating state and subsequent recovery fixes. The validation snapshot below describes the state before activation.

The five diagnosed failure causes are repaired in the working tree on `main`.
The additive migration is prepared and tested, but **not applied to production**.
No pipeline was restarted during this work. Research remains stopped; the News
and Polymarket collectors and Entity Manager remain online. API PID 1719088,
restart count 1 and uptime identity 1791000387540 are unchanged.

Ollama billing is restored: the actual production-profile structured writing
probe succeeded on `ollama-cloud/glm-5.3-flash`, with one provider dispatch,
zero repairs, zero tools and no fallback. Automatic GPT fallback remains disabled.

## Behaviour repaired

| Failure | Resulting behaviour |
| --- | --- |
| Existing entities omitted by the 32-candidate cap | Rank exact names/aliases and relevant profiles before bounding public/private candidates. Before admitting creation, look up the proposal's exact identity and ask Jev to confirm an existing match when present. An ambiguous or failed identity lookup still holds. |
| Creation blocked by unrelated broad context overflow | Entity Manager uses exact identity coverage for creation and distinguishes candidate overflow from general history truncation. Identity collisions still hold; no automatic merge. |
| Continuation/branch selected without a prior item | Jev chooses one valid relationship and historical origin/item together. With no target, only standalone or uncertain outcomes are offered. |
| Primary duplicate disagrees with novelty | One additional durable Jev decision chooses a consistent novelty/relationship against the verified primary target. A new development can become a linked or standalone entry; unresolved disagreement still holds. No retry loop or replacement of an unknown paid dispatch. |
| PANews domain migration rejected | New retrieval plans explicitly permit `panewslab.com`/`www.panewslab.com` to redirect to `panews.io`. Other redirect destinations still need approval in the plan, and every DNS address must remain public. |
| Large HTML page exceeds download limit or pollutes the article | Default capture allowance is 3,000,000 bytes per source and 9,000,000 total. Deterministic extraction preserves all marked article-body sections, excluding menus, executable content and adjacent recommendations. Readability handles pages without marked bodies. Response-byte hashes and extracted text remain separate provenance. |
| Broken IPv6 route or stalled fetch | Prefer validated IPv4 addresses, then try another validated address only for connection failures. DNS, connection, redirects and download share the existing hard 30-second deadline; each connection has a bounded five-second establishment allowance. |
| Model/proposal wall-time allowance | New light/standard admissions receive 180 seconds under budget policy v2. Existing saved work retains its allowance; unresolved older calls are not resent or reset. |

Jev's full-source admission bound remains **16,000 characters**, and state remains
bounded to 96,000 bytes. Article extraction removes page boilerplate; genuinely
long source articles still produce an explicit hold. This change does not
silently truncate source text or activate web search.

The new parser dependencies are pinned. Collectors declare Node
`^22.22.2 || ^24.15.0 || >=26.0.0`; this host was verified on Node 24.18.0.

## Evidence and independent outcomes

| Scenario / oracle | Observed result |
| --- | --- |
| Raoul Pal: an independently verified active private identity was absent from both original stored shortlists | The isolated database regression ranks an exact identity above more than 32 broad matches. A live read-only model probe, given the verified identity and current history, selected existing entity `0b79c2e2-d47a-792c-103a-b0d2e3451610`, a branch to managed item `44dd8065-47f0-5047-869d-ab68163db283`, and new information. |
| ZachXBT: original saved decisions selected primary duplicate plus new information | One live Jev reconciliation against the retained source and exact managed target returned `new_information` + `direct_continuation`, targeting `9d7b9ff8-ee7f-5438-b075-562bd13fd791`. This was an isolated decision probe, not recovery or a production write. |
| Both rejected PANews URLs | HTTP 200 through the explicitly approved redirect; captured article bodies were 128 and 580 characters, with surrounding recommendations excluded. |
| Forkast URL previously failing even with 60 seconds | HTTP 200 in about 3.5 seconds; 5,119-character complete extracted article, without the promotional footer. |
| CoinDesk page previously rejected at one megabyte | HTTP 200, about 1.75 MB downloaded and 3,379 article characters extracted without truncation. The current page differs from its discovery title; retrieval success is not confirmation of the old headline's facts. |
| Actual live Jev → Hermes/Ollama packet, then Entity Manager | Real source/model output persisted as one new dated article in isolated PostgreSQL, linked to its copied prior item. Source text/hash/publication time matched the packet; replay created zero further items; formal evidence rows remained zero. |

The Raoul live model probe supplements the current production catalogue with the
independently verified exact identity and ranks it locally. **It does not prove
the unapplied production SQL ranks correctly.** The new SQL is verified in the
isolated PostgreSQL fixture. The persistence fixture copies only the real entity
and minimal prior item; it is not a complete production database replica.

- **328 regression tests passed**, zero failures, cancellations or skips. Coverage
  includes Research worker/recovery, gateway/D2 reservations, candidate/history
  readers, source safety, extraction, triage and new decisions.
- **Six isolated PostgreSQL article tests passed**, including exact identity and
  alias ranking, creation amid unrelated overflow, duplicate-source attachment,
  chronology, writer isolation and restored migration-role privileges.
- Collectors TypeScript (`pnpm --filter @myboon/collectors exec tsc --noEmit`)
  and whitespace validation passed.
- Broader checks initially exposed legacy worker/shadow fixtures expecting News
  articles to bypass Jev. Two failures were reproduced on clean checkpoint
  `124f565`. The generic fixtures now use supported calendar signals, and explicit
  article-guard tests confirm zero unprepared synthesis. The production guard was
  preserved. A stalled test waiting for that prohibited call was terminated;
  the final run completed with zero cancellations.

Reproducible host-local receipts are in `/tmp/myboon-feature-fix-20261006/`:
`before-retrieval.jsonl`, `live-retrieval.json`, `baseline-regressions.log`,
`final-regressions.log`, `postgres-tests.log`, `final-typescript.log`,
`live-decision.log`, `live-reconciliation.json`, and `live-persistence.json`.
Full private packets/fixture inputs are local diagnostic material, not Git assets.

No production source, work, item, hold, dead letter or reservation was replayed,
rewritten or reset. Provider tests used isolated decision stores and logical IDs.

## Activation handoff

The prepared migration is
`supabase/migrations/20261006112717_article_entity_candidate_resolution.sql`.
It replaces only the internal private `article_context_v1` function, preserving
the dedicated login restriction, function owner and existing grants. Temporary
migration-role privileges are restored before the transaction commits. Older
applied migrations are unchanged; no public API/reader function is added.

When activation is requested:

1. Apply the additive migration transaction and verify exact public/private
   identity reads with the dedicated context login. Creation fails closed if the
   current `candidateTruncated` coverage field is unavailable.
2. Load the new code for News intake and Entity Manager, then resume Research
   with the existing News-only authority and Ollama-only configuration. Use the
   private four-pipeline release configuration and explicit process names.
   **Never use a global PM2 restart or touch `myboon-api`.**
3. Observe fresh admissions carrying retrieval/budget policy v2 and relationship/
   novelty decision v2, through accepted private writer receipts and chronology.
   Already queued work keeps its saved budget and retrieval plan.
4. Keep historical dead letters and unresolved paid outcomes retained for
   explicit D1 assessment/D2 reconciliation. No bulk recovery is part of this fix.

Semantic ambiguity, inaccessible publishers, genuinely long articles and unknown
paid outcomes remain legitimate explicit holds. These fixes address the sampled
structural failures; they do not establish universal model accuracy or article
completion.
