import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityHint, ResearchPacketV1 } from '../signal-platform/contracts'
import { groundingSkipSuffix, groundManagedEntities, mapEntityHintTypesToKinds } from './managed-canonical-processor'
import type { ManagedEntityBinding, ManagedResearchContext } from './postgres-knowledge-writer'

function contextEntity(overrides: Partial<ManagedEntityBinding> = {}): ManagedEntityBinding {
  return {
    id: overrides.id ?? 'entity-bitcoin',
    slug: overrides.slug ?? 'bitcoin',
    name: overrides.name ?? 'Bitcoin',
    type: overrides.type ?? 'asset',
    aliases: overrides.aliases ?? [],
    summary: overrides.summary ?? null,
    status: overrides.status ?? 'active',
    show_in_carousel: overrides.show_in_carousel ?? false,
    metadata: overrides.metadata ?? {},
    revision: overrides.revision ?? 'entity-revision',
    catalogEntityId: overrides.catalogEntityId ?? null,
    identityKey: overrides.identityKey ?? 'asset:bitcoin',
  }
}

function context(entities: ManagedEntityBinding[]): ManagedResearchContext {
  return { entities, items: [], digest: 'context-digest', watermark: 'watermark', truncated: false }
}

function hint(overrides: Partial<EntityHint> = {}): EntityHint {
  return {
    name: overrides.name ?? 'Example',
    type: Object.prototype.hasOwnProperty.call(overrides, 'type') ? overrides.type ?? null : null,
    role: Object.prototype.hasOwnProperty.call(overrides, 'role') ? overrides.role ?? null : null,
    aliases: overrides.aliases ?? [],
    source: overrides.source ?? 'research',
    claimRefs: overrides.claimRefs ?? ['claim-1'],
    evidenceRefs: overrides.evidenceRefs ?? ['evidence-1'],
  }
}

test('an evidenced membership hint matching an existing identity grounds it and never creates a second binding', () => {
  const result = groundManagedEntities(context([contextEntity({ aliases: ['BTC'] })]), [hint({
    name: 'Bitcoin (BTC)',
    type: 'asset',
    role: 'secondary_subject',
    aliases: [],
  })])

  assert.deepEqual(result.entities.map((entity) => entity.id), ['entity-bitcoin'])
  // The base of the parenthetical hint name grounds the existing Bitcoin identity:
  // the context alias `BTC` corroborates the `BTC` qualifier.
  assert.deepEqual(result.claimsByEntity.get('entity-bitcoin'), ['claim-1'])
  assert.equal(result.skipped.size, 0)
})

test('a hint that grounds and creates nothing is tallied with its skip reasons', () => {
  const alpha = contextEntity({ id: 'entity-alpha', slug: 'alpha-coin', name: 'Alpha Coin', aliases: ['BTC'] })
  const beta = contextEntity({ id: 'entity-beta', slug: 'beta-coin', name: 'Beta Coin', aliases: ['BTC'] })
  const result = groundManagedEntities(context([alpha, beta]), [hint({
    name: 'Bitcoin (BTC)',
    type: 'asset',
    role: 'secondary_subject',
    aliases: ['BTC'],
  })])

  assert.deepEqual(result.entities, [])
  // Both BTC matches are ambiguous, and the hinted keys collide with the context aliases.
  assert.deepEqual(Object.fromEntries(result.skipped), { ambiguous_alias: 1, existing_identity_collision: 1 })
})

test('a non-membership hint grounds nothing and is tallied as not_member_role', () => {
  const result = groundManagedEntities(context([contextEntity({ aliases: ['BTC'] })]), [hint({
    name: 'Bitcoin (BTC)',
    type: 'asset',
    role: 'publisher',
  })])

  assert.deepEqual(result.entities, [])
  assert.deepEqual(Object.fromEntries(result.skipped), { non_authoritative_role: 1, not_member_role: 1 })
  const suffix = groundingSkipSuffix(result.skipped)
  assert.equal(suffix, '; grounding: non_authoritative_role=1, not_member_role=1')
  assert.ok(`${'No explicitly evidenced entity identity can be grounded; the complete saved Research packet is retained'}${suffix}`.includes('; grounding:'))
})

test('the grounding skip suffix drops whole entries to keep the hold reason bounded', () => {
  const skipped = new Map<string, number>()
  for (let index = 0; index < 40; index += 1) skipped.set(`very_long_reason_name_padding_${index}`, index + 1)
  const reason = `No explicitly evidenced entity identity can be grounded; the complete saved Research packet is retained${groundingSkipSuffix(skipped)}`

  assert.ok(reason.length < 600)
  assert.ok(reason.includes('; grounding: very_long_reason_name_padding_0=1'), reason)
})

test('#342 PR-4 a created managed binding carries the mapped kind as its type', () => {
  const result = groundManagedEntities(context([contextEntity()]), [hint({
    name: 'DefiLlama',
    type: 'data provider',
    role: 'secondary_subject',
    aliases: [],
  })])

  assert.equal(result.entities.length, 1)
  assert.equal(result.entities[0]!.type, 'organization')
  assert.equal(result.entities[0]!.identityKey, 'organization:defillama')
})

test('#342 PR-4 hint types in the saved packet are mapped to the eleven kinds', () => {
  const packet = {
    entityHints: [
      hint({ name: 'DefiLlama', type: 'data provider', role: 'primary' }),
      hint({ name: 'RunUp', type: 'project', role: null }),
      hint({ name: 'Ghost', type: null, role: null }),
      hint({ name: 'Weird', type: 'made-up-kind', role: null }),
      hint({ name: 'Already Kind', type: 'regulation', role: null }),
    ],
  } as unknown as ResearchPacketV1
  const mapped = mapEntityHintTypesToKinds(packet)

  assert.deepEqual(mapped.entityHints.map((item) => item.type), ['organization', 'protocol', null, 'unclassified', 'regulation'])
  // Names, aliases and claim/evidence refs are untouched.
  assert.equal(mapped.entityHints[0]!.name, 'DefiLlama')
  assert.deepEqual(mapped.entityHints[0]!.claimRefs, ['claim-1'])
  assert.equal(mapped.entityHints[0]!.source, 'research')
})