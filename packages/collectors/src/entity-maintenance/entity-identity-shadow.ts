import { buildEntityMaintenanceCandidates } from './candidates'
import type {
  EntityCatalogProfile,
  EntityIdentityDecision,
  EntityMaintenanceCandidate,
} from './contracts'

export interface EntityIdentityShadowFixture {
  caseId: string
  expectedDecision: EntityIdentityDecision
  expectedPollutedEntityId: string | null
  expectedPollutedAlias: string | null
  candidate: EntityMaintenanceCandidate
}

/** Stable adversarial fixtures used by the shared classification gateway shadow. */
export function entityIdentityShadowFixtures(): EntityIdentityShadowFixture[] {
  return [
    fixture({
      caseId: 'polluted-gpt-solana-alias', expectedDecision: 'polluted_alias',
      expectedPollutedEntityId: 'entity-gpt-5-6', expectedPollutedAlias: 'Solana',
      left: profile({ id: 'entity-gpt-5-6', name: 'GPT-5.6', slug: 'openai-gpt-5-6', type: 'product', aliases: ['GPT 5.6', 'Solana'], summary: 'OpenAI model family.' }),
      right: profile({ id: 'entity-solana', name: 'Solana', slug: 'solana', type: 'network', aliases: ['SOL'], summary: 'A blockchain network.' }),
    }),
    fixture({
      caseId: 'polluted-gpt-sec-alias', expectedDecision: 'polluted_alias',
      expectedPollutedEntityId: 'entity-gpt-5-6-sec', expectedPollutedAlias: 'SEC',
      left: profile({ id: 'entity-gpt-5-6-sec', name: 'GPT-5.6', slug: 'openai-gpt-5-6-sec-fixture', type: 'product', aliases: ['GPT 5.6', 'SEC'], summary: 'OpenAI model family.' }),
      right: profile({ id: 'entity-sec', name: 'U.S. Securities and Exchange Commission', slug: 'us-securities-and-exchange-commission', type: 'organization', aliases: ['SEC'], summary: 'United States securities regulator.' }),
    }),
    fixture({
      caseId: 'legitimate-network-asset-split', expectedDecision: 'different_entities',
      expectedPollutedEntityId: null, expectedPollutedAlias: null,
      left: profile({ id: 'entity-solana-network', name: 'Solana', slug: 'solana-network', type: 'network', aliases: ['SOL'], summary: 'The Solana blockchain network.' }),
      right: profile({ id: 'entity-sol-asset', name: 'SOL', slug: 'sol-token', type: 'asset', aliases: ['$SOL'], summary: 'The native asset used on the Solana network.' }),
    }),
    fixture({
      caseId: 'duplicate-sec-records', expectedDecision: 'same_entity',
      expectedPollutedEntityId: null, expectedPollutedAlias: null,
      left: profile({ id: 'entity-sec-canonical', name: 'U.S. Securities and Exchange Commission', slug: 'us-securities-and-exchange-commission', type: 'organization', aliases: ['SEC'], summary: 'United States securities regulator.', memoryCount: 20, sourceCount: 8 }),
      right: profile({ id: 'entity-sec-duplicate', name: 'Securities and Exchange Commission', slug: 'securities-and-exchange-commission', type: 'organization', aliases: ['SEC', 'U.S. Securities and Exchange Commission'], summary: 'The US Securities and Exchange Commission.', memoryCount: 2, sourceCount: 1 }),
    }),
  ]
}

function fixture(input: {
  caseId: string
  expectedDecision: EntityIdentityDecision
  expectedPollutedEntityId: string | null
  expectedPollutedAlias: string | null
  left: EntityCatalogProfile
  right: EntityCatalogProfile
}): EntityIdentityShadowFixture {
  const candidates = buildEntityMaintenanceCandidates([input.left, input.right])
  if (candidates.length !== 1) throw new Error(`Shadow fixture ${input.caseId} must produce exactly one candidate.`)
  return { ...input, candidate: candidates[0]! }
}

function profile(input: Partial<EntityCatalogProfile> & Pick<EntityCatalogProfile, 'id' | 'name'>): EntityCatalogProfile {
  const timestamp = '2026-09-20T00:00:00.000Z'
  return {
    id: input.id, name: input.name,
    slug: input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    type: input.type ?? 'organization', aliases: input.aliases ?? [], summary: input.summary ?? null,
    status: input.status ?? 'active', showInCarousel: input.showInCarousel ?? false,
    tags: input.tags ?? [], createdAt: input.createdAt ?? timestamp, updatedAt: input.updatedAt ?? timestamp,
    changedAt: input.changedAt ?? timestamp, memoryCount: input.memoryCount ?? 0,
    sourceCount: input.sourceCount ?? 0, firstMemoryAt: input.firstMemoryAt ?? null,
    lastMemoryAt: input.lastMemoryAt ?? null, recentMemories: input.recentMemories ?? [],
  }
}
