import assert from 'node:assert/strict'
import test from 'node:test'
import { ArticleResearchHold, prepareArticlePlacement } from './article-placement'
import {
  ARTICLE_308_CRYPTO_SIGNAL, ARTICLE_308_CRYPTO_TITLE, ARTICLE_308_EXACT_IDENTITY_PROPOSAL,
  ARTICLE_308_IRAN_SIGNAL, ARTICLE_308_IRAN_TEXT, ARTICLE_308_PRIORS,
  article308BlackRockPlan, article308CryptoContext, article308EmptyContext, article308FindExactIdentity,
  article308Gateway, article308IranContext, article308IranPlan, article308Signal,
} from './article-308-fixtures'
import {
  ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION,
} from '../inference-gateway/classification-definitions'

// #308 patch 5B. These tests run prepareArticlePlacement against mocked
// classification gateways only. They pin plumbing — dispatch order, decision
// versions, durable item ids/origins/dates and the deterministic judgment
// flow across flags — not model accuracy: every provider answer is a fixture
// value, and nothing here evaluates whether a real model classifies well.

test('#308 Iran proposal article places the conflict primary with independent memberships (batching off)', async () => {
  const { gateway, requests } = article308Gateway(article308IranPlan())
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-iran',
    signal: ARTICLE_308_IRAN_SIGNAL, sourceText: ARTICLE_308_IRAN_TEXT, context: article308IranContext() })
  const workloads = requests.map((request) => request.workload)
  assert.equal(workloads[0], 'research.article_entity_placement')
  assert.equal(workloads[1], 'research.article_related_membership')
  assert.deepEqual(workloads.slice(2, -1).sort(), Array.from({ length: 4 }, () => 'research.article_story_relationship').sort())
  assert.equal(workloads.at(-1), 'research.article_novelty')
  assert.deepEqual(requests.filter((request) => request.workload.endsWith('story_relationship'))
    .map((request) => (request.state as { entity: { id: string } }).entity.id).sort(), ['conflict', 'iran', 'qatar', 'us'])
  assert.equal((requests[0].state as { article: { text: string } }).article.text, ARTICLE_308_IRAN_TEXT)
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]).slice(1).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    [['iran', 'related'], ['qatar', 'related'], ['us', 'related']])
  const primary = result.memberships[0]
  assert.equal(primary.entityId, 'conflict'); assert.equal(primary.role, 'primary')
  assert.equal(primary.relationship, 'direct_continuation')
  assert.equal(primary.priorItemId, 'conflict-1'); assert.equal(primary.priorItemSource, 'managed')
  assert.equal(primary.priorItemDecision?.choice, 'conflict-1')
  assert.equal(primary.relationshipDecision?.choice, 'direct_continuation')
  assert.equal(primary.placement.choice, 'conflict')
  assert.equal(primary.placement.probabilities.conflict, .95)
  assert.equal(primary.duplicateTarget, null)
  for (const membership of result.memberships.slice(1)) {
    assert.equal(membership.relationship, 'same_topic_only')
    assert.equal(membership.priorItemId, null); assert.equal(membership.duplicateTarget, null)
  }
  assert.equal(result.novelty.choice, 'new_information')
  assert.equal(result.novelty.probabilities.new_information, .95)
  assert.equal(result.novelty.decisionVersion, 'research.article_novelty.v2')
  assert.match(result.contextualHistory, /\[managed:conflict-1\] 2026-10-01T00:00:00Z — U.S. proposal sent to Iran through Qatar/)
})

test('#308 Iran proposal article batches into three dispatches (batching on)', async () => {
  const { gateway, requests } = article308Gateway(article308IranPlan())
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-iran',
    signal: ARTICLE_308_IRAN_SIGNAL, sourceText: ARTICLE_308_IRAN_TEXT, context: article308IranContext(), useBatching: true })
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map((request) => request.workload), [
    'research.article_catalogue_batch', 'research.article_relationship_batch', 'research.article_novelty',
  ])
  assert.deepEqual((requests[0].state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id),
    ['conflict', 'iran', 'qatar', 'us'])
  assert.deepEqual((requests[1].state as { entities: Array<{ id: string }> }).entities.map((entity) => entity.id),
    ['conflict', 'iran', 'qatar', 'us'])
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]),
    [['conflict', 'primary'], ['iran', 'related'], ['qatar', 'related'], ['us', 'related']])
  const primary = result.memberships[0]
  assert.equal(primary.relationship, 'direct_continuation')
  assert.equal(primary.priorItemId, 'conflict-1'); assert.equal(primary.priorItemSource, 'managed')
  assert.equal(primary.duplicateTarget, null)
  for (const membership of result.memberships.slice(1)) {
    assert.equal(membership.relationship, 'same_topic_only')
    assert.equal(membership.priorItemId, null); assert.equal(membership.duplicateTarget, null)
  }
  assert.equal(result.novelty.choice, 'new_information')
  for (const request of requests.slice(0, 2)) {
    assert.equal(JSON.stringify(request.state).split(ARTICLE_308_IRAN_TEXT).length - 1, 1,
      `${request.workload} must carry the article text exactly once`)
  }
})

test('#308 BlackRock Bitcoin article continues each supplied prior (batching off)', async () => {
  // The fixture priors pin the durable identities: managed:btc-1 and legacy:br-1, both 2026-10-01.
  assert.equal(ARTICLE_308_PRIORS.btcAccumulation.id, 'btc-1'); assert.equal(ARTICLE_308_PRIORS.btcAccumulation.source, 'managed')
  assert.equal(ARTICLE_308_PRIORS.btcAccumulation.eventAt, '2026-10-01T00:00:00Z')
  assert.equal(ARTICLE_308_PRIORS.btcAccumulation.title, 'BlackRock begins accumulating Bitcoin')
  assert.equal(ARTICLE_308_PRIORS.brAllocation.id, 'br-1'); assert.equal(ARTICLE_308_PRIORS.brAllocation.source, 'legacy')
  assert.equal(ARTICLE_308_PRIORS.brAllocation.eventAt, '2026-10-01T00:00:00Z')
  assert.equal(ARTICLE_308_PRIORS.brAllocation.title, 'BlackRock announces Bitcoin allocation')
  const { gateway, requests } = article308Gateway(article308BlackRockPlan())
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-blackrock-bitcoin',
    signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: ARTICLE_308_CRYPTO_TITLE, context: article308CryptoContext() })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]),
    [['bitcoin', 'primary'], ['blackrock', 'related']])
  const [primary, related] = result.memberships
  assert.equal(primary.placement.choice, 'bitcoin'); assert.equal(primary.placement.probabilities.bitcoin, .95)
  assert.equal(primary.relationship, 'direct_continuation')
  assert.equal(primary.priorItemId, 'btc-1'); assert.equal(primary.priorItemSource, 'managed')
  assert.equal(primary.priorItemDecision?.choice, 'btc-1')
  assert.equal(primary.duplicateTarget, null)
  assert.equal(related.relationship, 'direct_continuation')
  assert.equal(related.priorItemId, 'br-1'); assert.equal(related.priorItemSource, 'legacy')
  assert.equal(related.priorItemDecision?.choice, 'br-1')
  assert.equal(related.duplicateTarget, null)
  assert.equal(result.novelty.choice, 'new_information')
  assert.match(result.contextualHistory, /\[managed:btc-1\] 2026-10-01T00:00:00Z — BlackRock begins accumulating Bitcoin/)
  assert.match(result.contextualHistory, /\[legacy:br-1\] 2026-10-01T00:00:00Z — BlackRock announces Bitcoin allocation/)
  assert.deepEqual(requests.at(-1)!.workload, 'research.article_novelty')
  const noveltyState = requests.at(-1)!.state as { histories: Array<{ entityId: string, items: Array<{ id: string, source: string }> }> }
  // Novelty history follows membership order: primary first, then related.
  assert.deepEqual(noveltyState.histories.map((history) => history.entityId), ['bitcoin', 'blackrock'])
  assert.deepEqual(noveltyState.histories.find((history) => history.entityId === 'bitcoin')?.items.map((item) => item.id), ['btc-1'])
  assert.deepEqual(noveltyState.histories.find((history) => history.entityId === 'blackrock')?.items.map((item) => item.id), ['br-1'])
})

test('#308 BlackRock Bitcoin article batches into three dispatches with the same links (batching on)', async () => {
  const { gateway, requests } = article308Gateway(article308BlackRockPlan())
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-blackrock-bitcoin',
    signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: ARTICLE_308_CRYPTO_TITLE, context: article308CryptoContext(), useBatching: true })
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map((request) => request.workload), [
    'research.article_catalogue_batch', 'research.article_relationship_batch', 'research.article_novelty',
  ])
  assert.deepEqual(requests.map((request) => request.decisionVersion), [
    'research.article_catalogue_batch.v1', 'research.article_relationship_batch.v1', 'research.article_novelty.v2',
  ])
  assert.deepEqual((requests[0].state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id),
    ['bitcoin', 'blackrock'])
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]),
    [['bitcoin', 'primary'], ['blackrock', 'related']])
  const [primary, related] = result.memberships
  assert.equal(primary.relationship, 'direct_continuation')
  assert.equal(primary.priorItemId, 'btc-1'); assert.equal(primary.priorItemSource, 'managed')
  assert.equal(related.relationship, 'direct_continuation')
  assert.equal(related.priorItemId, 'br-1'); assert.equal(related.priorItemSource, 'legacy')
  for (const membership of result.memberships) assert.equal(membership.duplicateTarget, null)
  assert.equal(result.novelty.choice, 'new_information')
})

// #343 change 2: a Hermes result carries no numeric confidence, so a Hermes
// placement — and a Hermes prior-item link — counts as below its floor and
// holds the article as uncertain before any later stage runs.
test('#308 Hermes fallback versions dispatch the fallback registry, then a scoreless Hermes placement holds', async () => {
  const placementFallback = article308Gateway({ ...article308BlackRockPlan(), hermes: (request) => request.workload === 'research.article_entity_placement' })
  await assert.rejects(
    prepareArticlePlacement({ gateway: placementFallback.gateway, stableDecisionKey: 'article-308-hermes',
      signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: ARTICLE_308_CRYPTO_TITLE, context: article308CryptoContext(), useHermesFallbackVersions: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /no confidence score \(provider hermes\)/.test(error.message),
  )
  assert.equal(placementFallback.requests[0].decisionVersion, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION)
  // A full Hermes journey holds the same way before its linked prior item saves.
  const allHermes = article308Gateway({ ...article308BlackRockPlan(), hermes: () => true })
  await assert.rejects(
    prepareArticlePlacement({ gateway: allHermes.gateway, stableDecisionKey: 'article-308-hermes-all',
      signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: ARTICLE_308_CRYPTO_TITLE, context: article308CryptoContext(), useHermesFallbackVersions: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /no confidence score \(provider hermes\)/.test(error.message),
  )
  assert.equal(allHermes.requests[0].decisionVersion, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION)
})

test('#308 a same-event second report reuses the one primary duplicate target as already known', async () => {
  const { gateway, requests } = article308Gateway({
    placement: { entityId: 'bitcoin', disposition: 'selected' },
    relationships: { bitcoin: { relationship: 'duplicate', priorItemId: 'btc-1', priorItemSource: 'managed' } },
    novelty: 'already_known',
  })
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-second-report',
    signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: 'Second report of the same Bitcoin holdings development.',
    context: article308CryptoContext(['bitcoin']) })
  assert.equal(requests.length, 3)
  const membership = result.memberships[0]
  assert.equal(membership.relationship, 'duplicate')
  assert.equal(membership.priorItemId, 'btc-1'); assert.equal(membership.priorItemSource, 'managed')
  assert.deepEqual(membership.duplicateTarget, { itemId: 'btc-1', source: 'managed', entityId: 'bitcoin' })
  assert.equal(result.novelty.choice, 'already_known')
})

test('#308 a later outcome continues the prior development as new information', async () => {
  const { gateway } = article308Gateway({
    placement: { entityId: 'bitcoin', disposition: 'selected' },
    relationships: { bitcoin: { relationship: 'direct_continuation', priorItemId: 'btc-1', priorItemSource: 'managed' } },
    novelty: 'new_information',
  })
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-outcome',
    signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: 'The outcome of the earlier Bitcoin accumulation landed.',
    context: article308CryptoContext(['bitcoin']) })
  const membership = result.memberships[0]
  assert.equal(membership.relationship, 'direct_continuation')
  assert.equal(membership.priorItemId, 'btc-1'); assert.equal(membership.priorItemSource, 'managed')
  assert.equal(membership.duplicateTarget, null)
  assert.equal(result.novelty.choice, 'new_information')
})

test('#308 a sanctions development branches from the prior narrative', async () => {
  const { gateway } = article308Gateway({
    placement: { entityId: 'bitcoin', disposition: 'selected' },
    relationships: { bitcoin: { relationship: 'related_story_branch', priorItemId: 'btc-1', priorItemSource: 'managed' } },
    novelty: 'new_information',
  })
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-branch',
    signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: 'A new Bitcoin sanctions development arrived.',
    context: article308CryptoContext(['bitcoin']) })
  const membership = result.memberships[0]
  assert.equal(membership.relationship, 'related_story_branch')
  assert.equal(membership.priorItemId, 'btc-1'); assert.equal(membership.priorItemSource, 'managed')
  assert.equal(membership.duplicateTarget, null)
  assert.equal(result.novelty.choice, 'new_information')
})

test('#308 an unrelated Bitcoin movement stays same_topic_only without a prior link', async () => {
  const { gateway } = article308Gateway({
    placement: { entityId: 'bitcoin', disposition: 'selected' },
    relationships: { bitcoin: { relationship: 'same_topic_only' } },
    novelty: 'new_information',
  })
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-unrelated',
    signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: 'An unrelated Bitcoin price movement.',
    context: article308CryptoContext(['bitcoin']) })
  const membership = result.memberships[0]
  assert.equal(membership.relationship, 'same_topic_only')
  assert.equal(membership.priorItemId, null); assert.equal(membership.priorItemSource, null)
  assert.equal(membership.duplicateTarget, null)
  assert.equal(membership.priorItemDecision?.choice, 'none')
  assert.match(result.contextualHistory, /has no selected prior item/)
})

test('#308 a duplicate naming a missing durable target holds without a novelty call', async () => {
  const { gateway, requests } = article308Gateway({
    placement: { entityId: 'bitcoin', disposition: 'selected' },
    // A tampered durable result names a target outside the supplied history;
    // the raw path replays it verbatim instead of a decodable Jev answer.
    relationships: { bitcoin: { relationship: 'duplicate', priorItemId: 'missing-item', priorItemSource: 'managed',
      raw: { relationship: 'duplicate', priorItemId: 'missing-item', priorItemSource: 'managed' } } },
    novelty: 'already_known',
  })
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-missing-target',
      signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: 'Second report of the same development.',
      context: article308CryptoContext(['bitcoin']) }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /duplicate without a valid durable historical target/.test(error.message),
  )
  assert.equal(requests.length, 2)
  assert.equal(requests.some((request) => request.workload.endsWith('novelty')), false)
})

test('#308 a primary duplicate with contradictory new_information novelty holds after one reconciliation', async () => {
  const { gateway, requests } = article308Gateway({
    placement: { entityId: 'bitcoin', disposition: 'selected' },
    relationships: { bitcoin: { relationship: 'duplicate', priorItemId: 'btc-1', priorItemSource: 'managed' } },
    novelty: 'new_information',
    noveltyReconcile: { verdict: 'new_information' },
  })
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-contradictory',
      signal: ARTICLE_308_CRYPTO_SIGNAL, sourceText: 'Second report of the same development.',
      context: article308CryptoContext(['bitcoin']) }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /exact duplicate target/.test(error.message),
  )
  assert.equal(requests.length, 4)
  assert.equal(requests.filter((request) => request.workload.endsWith('novelty')).length, 2)
  const reconcileState = requests[3].state as { reconciliation: { priorVerdict: string }, selectedTargets: Array<{ entityId: string, role: string, id: string, source: string }> }
  assert.equal(reconcileState.reconciliation.priorVerdict, 'new_information')
  assert.equal(reconcileState.selectedTargets.length, 1)
  assert.equal(reconcileState.selectedTargets[0].entityId, 'bitcoin')
  assert.equal(reconcileState.selectedTargets[0].role, 'primary')
  assert.equal(reconcileState.selectedTargets[0].id, 'btc-1')
  assert.equal(reconcileState.selectedTargets[0].source, 'managed')
})

test('#308 an empty catalogue without a creation proposal holds after the placement dispatch only', async () => {
  const { gateway, requests } = article308Gateway({ placement: { entityId: null, disposition: 'no_match' } })
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-empty',
      signal: article308Signal({ title: 'An unmatched development', signalId: 'article-308-empty' }),
      sourceText: 'An unmatched development.', context: article308EmptyContext() }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_no_match'
      && /no durable source-grounded creation proposal is configured/.test(error.message),
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].workload, 'research.article_entity_placement')
  assert.deepEqual((requests[0].state as { candidates: unknown[] }).candidates, [])
})

test('#308 a rejected creation proposal holds without admitting an identity', async () => {
  const proposal = { name: 'Solana Policy Institute', type: 'organization', aliases: [], summary: 'A proposed policy organization.', scope: {} }
  const { gateway, requests } = article308Gateway({ placement: { entityId: null, disposition: 'no_match' }, proposal: 'reject' })
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-rejected',
      signal: article308Signal({ title: 'A proposed institute', signalId: 'article-308-rejected' }),
      sourceText: 'A proposed institute.', context: article308EmptyContext(), proposeCreation: async () => proposal }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_no_match'
      && /proposal was rejected/.test(error.message),
  )
  assert.deepEqual(requests.map((request) => request.workload), ['research.article_entity_placement', 'research.article_entity_proposal_validation'])
  assert.equal((requests[1].state as { proposal: { name: string } }).proposal.name, 'Solana Policy Institute')
})

test('#308 an uncertain creation proposal holds', async () => {
  const proposal = { name: 'Solana Policy Institute', type: 'organization', aliases: [], summary: 'A proposed policy organization.', scope: {} }
  const { gateway } = article308Gateway({ placement: { entityId: null, disposition: 'no_match' }, proposal: 'uncertain' })
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'article-308-uncertain-proposal',
      signal: article308Signal({ title: 'A proposed institute', signalId: 'article-308-uncertain-proposal' }),
      sourceText: 'A proposed institute.', context: article308EmptyContext(), proposeCreation: async () => proposal }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /could not safely validate/.test(error.message),
  )
})

test('#308 an exact existing identity is selected instead of duplicated', async () => {
  const exactIdentityLabels: string[][] = []
  const { gateway, requests } = article308Gateway({
    placement: (candidates) => candidates.some((candidate) => candidate.id === 'raoul-pal')
      ? { entityId: 'raoul-pal', disposition: 'selected' } : { entityId: null, disposition: 'no_match' },
    relationships: { 'raoul-pal': { relationship: 'same_topic_only' } },
    novelty: 'new_information',
  })
  const result = await prepareArticlePlacement({
    gateway, stableDecisionKey: 'article-308-exact-identity',
    signal: article308Signal({ title: 'Raoul Pal predicts a crypto bull run', signalId: 'article-308-exact-identity' }),
    sourceText: 'Raoul Pal predicts a crypto bull run.',
    context: { ...article308EmptyContext(), findExactEntities: async (labels) => { exactIdentityLabels.push([...labels]); return article308FindExactIdentity(labels) } },
    proposeCreation: async () => ARTICLE_308_EXACT_IDENTITY_PROPOSAL,
  })
  const membership = result.memberships[0]
  assert.equal(membership.entityId, 'raoul-pal'); assert.equal(membership.role, 'primary')
  assert.equal(membership.placementDisposition, 'selected'); assert.equal(membership.name, 'Raoul Pal')
  assert.equal(membership.creationProposal, null); assert.equal(membership.creationDecision, null)
  assert.equal(membership.relationship, 'same_topic_only'); assert.equal(membership.priorItemId, null)
  assert.deepEqual(exactIdentityLabels[0], ['Raoul Pal', 'Raoul'])
  assert.equal(requests.filter((request) => request.workload === 'research.article_entity_placement').length, 2)
  assert.match(requests[1].trace.stableDecisionKey, /placement:exact-identity$/)
  assert.equal(requests.some((request) => request.workload === 'research.article_entity_proposal_validation'), false)
  assert.equal(result.novelty.choice, 'new_information')
})