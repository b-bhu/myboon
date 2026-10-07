# V4 Research validation — 2026-10-03

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

The focused Research and Research Gate suites passed **209/209 tests, with no skips**. This run used mocked inference/classification transports and disposable local SQLite databases. It made no paid provider calls, production database writes, historical replay, deployment, or process restart. Private PostgreSQL and combined pipeline rehearsal results are recorded separately by the integration lane.

Run from `packages/collectors`:

```sh
pnpm exec tsx --test src/research-engine/*.test.ts src/research-engine/evaluation/*.test.ts src/research-gate/*.test.ts
```

The complete output is `/tmp/myboon-v4-research-tests-final-pass.log`. An additional five-test harness rerun after the final classification call-signature cleanup also passed. After test fixture typing cleanup, all 46 directly affected worker, reuse, runner and internal-reader cases passed again (`/tmp/myboon-v4-research-typing-followup.log`). Root owns final TypeScript and combined collectors verification.

## Behaviors exercised

| Area | Evidence |
| --- | --- |
| Actual shared worker and runner | News and Polymarket work reaches durable canonical readiness; enabled actual runner composes approved classifier and internal context ports in both priority pools; disabled mode constructs no provider/context runtime; injected ports cannot bypass ownership. |
| Guarded known observations | Complete captured source, complete related knowledge coverage, accepted known decision and unchanged current context avoid synthesis and follow-up. Raw source/captures remain stored; no factual claims or new Entity action are manufactured. The packet counts the novelty classification call. |
| Conservative comparison behavior | Incomplete/truncated/failed/unrelated or empty knowledge coverage never suppresses a signal as already known. Changed current context or explicit owed action keeps the ordinary Research path; stale saved no-item handoff is retained for review without additional spending. |
| Durability and unknown outcomes | Saved baseline and classifier responses survive database reopen and handoff failure without repeat spending. Unknown primary/follow-up/classification outcomes preserve exposure, retain the baseline where available and cannot acquire replacement allowance through continuation. |
| Bounded follow-up | Uncertain/not-worthwhile decisions buy no extra investigation. One approved fetch and one bounded synthesis may add a grounded contribution; an unproductive result preserves original claims/readiness and reports both synthesis calls. Extra synthesis has no repair allowance. |
| Aggregate reservation ledger | Independent SQLite connections race for one logical allowance and shared root caps. Provider-call exposure includes configured fallback/repair headroom; provider/token/cost caps are enforced independently. Unknown usage retains maxima, measured unused capacity may be released and a settled allowance cannot be minted again. |
| Strict whole-result reuse | Question, scope, applicability, full material, correction signature, current knowledge, policy, age and evidence digest must match. Exact immutable evidence IDs are remapped while attribution, partial completion and limitations remain intact. Missing references are rejected and correctly audited. |
| Source evidence reuse | Producer-owned immutable captures are pinned and remain unchanged. Consumer copies retain original capture time and store-qualified origin. Missing pins, corrections, changed body hashes, absent admission and oversized captures produce a miss. |
| D1/D2 operators | D1 requires explicit single-packet/operator authority and durable source pause; it saves assessment without canonical readiness, queue replay or promotion. D2 inspection does not mutate; unknown payments without a code-owned saved response remain held. |
| Actual internal reader | Class methods preserve their receiver through gate composition. Missing/failed/truncated private knowledge and omitted long-note bodies cannot justify skipping. Attachment target resolution requires one exact active accepted producer-packet reference. |

The new focused test files add 57 cases to the existing 152 Research/Gate cases. Shared temporary fixture helpers live in `packages/collectors/src/research-engine/v4-test-fixtures.ts`.

## Correctness fixes found during validation

- Canonical persisted JSON reordered budget keys. Identity comparison now uses canonical JSON, allowing exact saved-result re-entry without purchasing another call.
- Invalid negative, fractional, nonfinite or unsafe usage values could lower aggregate exposure. Settlement rejects them; unknown monetary usage must retain `null`. A stage cannot omit the already-established root policy to bypass aggregate enforcement.
- `buildNoveltyLookup` called a detached reader method, losing `this` for the actual private-context bridge. The call now preserves its receiver. Omitted note text also explicitly marks coverage incomplete.
- Shared Research recorded accepted known decisions but ignored their skip disposition. It now saves a claim-free known-observation packet and existing no-item readiness only after verifying complete source and current bounded context.
- No-item handoff validates its marker against immutable code-owned novelty records and persisted source/captures inside the SQLite transaction. Forged source/model markers are rejected. Saved no-item recovery rechecks context and holds if it changed.
- Whole-result reuse no longer records an accepted decision before checking all referenced captures. Invalid producer capture timestamps also fail eligibility. Classifier settlements retain a reported measured cost when supplied; absent cost remains unknown.

The no-item record uses the existing `novelty` record kind and `no_item_resolution` record ID. No additive table was introduced during validation. Its comparison digest, captured-evidence digest, source-material digest, consulted item references, decision digest and assessment time document the bounded proof. Knowledge is read at decision/commit time; this is not a cross-store transaction guarantee or timeless knowledge coverage.

## Prepared Jev evaluation

`packages/collectors/src/research-engine/evaluation/fixtures.ts` contains 20 explicitly synthetic, hand-labeled cases: 12 novelty and 8 follow-up cases across News and Polymarket. They cover repeated assertions, new body information, new authority, distinct odds moves, resolution, correction/retraction, incomplete lookups and bounded versus unsupported investigations. Their labels follow the supplied fictional state and do not establish real-world factual truth or represent production traffic.

The offline harness exports exact approved typed questions/state and the repository-pinned `jev-1.13.0` model. Each prepared request has a digest binding state, questions and model. It performs no network requests or credential reads:

```sh
pnpm exec tsx src/research-engine/evaluation/offline-evaluation.ts
pnpm exec tsx src/research-engine/evaluation/offline-evaluation.ts --recordings /absolute/path/recordings.json
```

Prepared requests were exported to `/tmp/myboon-v4-research-prepared-evaluation.json`. Recorded answers must identify the case, exact request digest, actual route, explicit `synthetic_mock` or `recorded_provider` provenance and native Choice answers. Optional usage must retain measured values or explicit unknowns. The scorer reports label agreement, confidence abstention, raw and guarded false-known counts, missing cases, latency, measured/unknown cost and optional paired total assignment calls. Total assignment accounting includes novelty and value classification plus primary and extra synthesis. It does not infer savings from unknown usage or from fewer synthesis calls alone.

Harness tests deliberately provide a high-confidence wrong-known answer on a complete-body case: coverage guards cannot repair a semantic classification error. This remains a real-model quality risk requiring evaluation. Mock agreement only validates arithmetic and policy wiring.

The [TypeSafe skill](/home/ubuntu/.codex/skills/typesafe-ai/SKILL.md) and live official [Choice documentation](https://docs.typesafe.ai/primitives/choice), [confidence guidance](https://docs.typesafe.ai/confidence), and [API reference](https://docs.typesafe.ai/api) were read. Native typed answers are decision inputs, not factual proof; Choice confidence describes concentration among options rather than verified accuracy. Existing registry thresholds and maximum lifecycle modes are preserved. No threshold calibration, new activation defaults or model-version change was introduced.

**Real paid Jev scoring remains pending an explicit evaluation budget.** No claim is made about real Jev quality, production acceptance rate, calibrated confidence, financial savings or activation readiness from these offline tests. A paid evaluation must retain every actual/unknown call and include the same-root end-to-end assignment cost before comparing with the current baseline.
