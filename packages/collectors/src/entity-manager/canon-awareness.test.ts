/**
 * Canon awareness: the entity manager consults the catalog BEFORE filing.
 *
 * Covers the four layers added for it:
 *  - the extraction prompt carries a shortlist menu + choose-don't-invent rules
 *  - the registrar reflection re-homes proposed creations onto existing entities
 *  - the resolver's deterministic near-duplicate snap and banned-slug drop
 *  - writeExtraction wiring: catalog loaded once, shortlist handed to the provider
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesService } from '../hermes'
import type { ExtractionCanon } from './canon'
import { HermesEntityExtractionProvider, __testing } from './extractor'
import { writeExtraction, __testing as resolverTesting } from './resolver'
import { InMemoryEntityMemoryStore } from './test-helpers'
import type { EntityMemoryExtraction, EntityRecord, PrimaryEntityCandidate, ResearchPacket } from './types'

function packet(overrides: Partial<ResearchPacket> = {}): ResearchPacket {
  return {
    id: 'p1',
    source: 'news',
    sourceArea: 'crypto',
    sourceResearchId: 'r1',
    sourceType: 'article',
    sourceRefId: 'ref-1',
    title: 'FOMC holds rates in a 9-3 vote',
    summary: 'The Federal Reserve held rates steady.',
    body: '',
    observedAt: '2026-07-31T00:00:00.000Z',
    evidence: [],
    metrics: {},
    context: {},
    ...overrides,
  }
}

function entityRecord(overrides: Partial<EntityRecord> & { slug: string }): EntityRecord {
  return {
    id: `id-${overrides.slug}`,
    name: overrides.slug,
    type: 'topic',
    aliases: [],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
    ...overrides,
  }
}

const FED = entityRecord({ slug: 'us-federal-reserve', name: 'Federal Reserve', type: 'organization', aliases: ['Fed', 'FOMC'] })
const NVIDIA = entityRecord({ slug: 'nvidia', name: 'NVIDIA', type: 'organization', aliases: ['NVDA'] })

function canonOf(...records: EntityRecord[]): ExtractionCanon {
  const catalog = records.map((record) => ({
    id: record.id,
    slug: record.slug,
    name: record.name,
    type: record.type,
    aliases: record.aliases,
    summary: record.summary,
  }))
  return { shortlist: catalog, catalog }
}

// ---------------------------------------------------------------- prompt ---

test('extraction prompt shows the shortlist menu and the choose-dont-invent rules', () => {
  const prompt = __testing.buildPrompt(packet(), canonOf(FED))

  assert.match(prompt, /KNOWN ENTITIES/)
  assert.match(prompt, /us-federal-reserve/)
  assert.match(prompt, /Creating a new entity is exceptional/)
  assert.match(prompt, /central bank entity, never a country entity/)
  assert.match(prompt, /One memory = one story/)
})

test('extraction prompt without canon has no menu (legacy behavior preserved)', () => {
  const prompt = __testing.buildPrompt(packet())
  assert.doesNotMatch(prompt, /KNOWN ENTITIES/)
})

// ------------------------------------------------------------- rehoming ---

test('rehomeCandidate moves the candidate and its memories onto the existing entity, carrying aliases', () => {
  const candidate: PrimaryEntityCandidate = { name: 'NVIDIA H100', type: 'asset', slug: 'nvidia-h100', aliases: ['H100'] }
  const extraction: EntityMemoryExtraction = {
    primaryEntities: [candidate],
    memories: [
      { entitySlug: 'nvidia-h100', memoryType: 'market_signal', title: 'H100 pricing', summary: 'H100 index moved.' },
    ],
  }

  const rehomed = __testing.rehomeCandidate(extraction, candidate, canonOf(NVIDIA).catalog[0])

  assert.equal(rehomed.primaryEntities.length, 1)
  assert.equal(rehomed.primaryEntities[0].slug, 'nvidia')
  assert.ok(rehomed.primaryEntities[0].aliases?.includes('H100'), 'the variant name becomes an alias of the canonical entity')
  assert.equal(rehomed.memories[0].entitySlug, 'nvidia')
})

// ------------------------------------------------- registrar reflection ---

function providerWith(responses: { extraction: string, registrar?: string, failRegistrar?: boolean }) {
  const prompts: string[] = []
  const service = new HermesService({
    command: 'hermes',
    execFileImpl: async (_cmd, args) => {
      const prompt = args[args.length - 1]
      prompts.push(prompt)
      if (prompt.includes('Entity Registrar')) {
        if (responses.failRegistrar) throw new Error('registrar down')
        return { stdout: responses.registrar ?? '', stderr: '' }
      }
      return { stdout: responses.extraction, stderr: '' }
    },
  })
  return { prompts, provider: new HermesEntityExtractionProvider({ service }) }
}

const EXTRACTION_PROPOSING_H100 = JSON.stringify({
  primaryEntities: [{ name: 'NVIDIA H100', type: 'asset', slug: 'nvidia-h100', aliases: ['H100'], createReason: 'GPU model in the news' }],
  memories: [{ entitySlug: 'nvidia-h100', memoryType: 'market_signal', title: 'H100 pricing', summary: 'H100 rental index doubled.' }],
})

test('a proposed creation triggers exactly one registrar reflection; file_under re-homes it', async () => {
  const { prompts, provider } = providerWith({
    extraction: EXTRACTION_PROPOSING_H100,
    registrar: '{"decision":"file_under","existing_slug":"nvidia","reason":"H100 is an NVIDIA product line."}',
  })

  const result = await provider.extract(packet({ title: 'H100 rental prices double' }), canonOf(NVIDIA))

  assert.equal(prompts.length, 2, 'extract + one registrar call')
  assert.equal(result.primaryEntities[0].slug, 'nvidia')
  assert.equal(result.memories[0].entitySlug, 'nvidia')
})

test('registrar verdict create keeps the creation', async () => {
  const { provider } = providerWith({
    extraction: EXTRACTION_PROPOSING_H100,
    registrar: '{"decision":"create","reason":"Genuinely distinct."}',
  })
  const result = await provider.extract(packet(), canonOf(NVIDIA))
  assert.equal(result.primaryEntities[0].slug, 'nvidia-h100')
})

test('registrar failure fails OPEN to the creation', async () => {
  const { provider } = providerWith({ extraction: EXTRACTION_PROPOSING_H100, failRegistrar: true })
  const result = await provider.extract(packet(), canonOf(NVIDIA))
  assert.equal(result.primaryEntities[0].slug, 'nvidia-h100')
})

test('no registrar call when the filing targets an existing catalog entity', async () => {
  const { prompts, provider } = providerWith({
    extraction: JSON.stringify({
      primaryEntities: [{ name: 'Federal Reserve', type: 'organization', slug: 'us-federal-reserve' }],
      memories: [{ entitySlug: 'us-federal-reserve', memoryType: 'news_event', title: 'FOMC holds', summary: 'Held 9-3.' }],
    }),
  })
  await provider.extract(packet(), canonOf(FED))
  assert.equal(prompts.length, 1, 'only the extraction call - reflection never fires on ordinary filings')
})

// ------------------------------------------------------ resolver guards ---

test('resolver snaps a granular variant onto the existing entity instead of creating it', async () => {
  const store = new InMemoryEntityMemoryStore()
  store.entities.push(entityRecord({ slug: 'china-taiwan', name: 'China-Taiwan tensions', aliases: ['Taiwan strait'] }))
  const catalog = canonOf(store.entities[0]).catalog

  const resolved = await resolverTesting.resolvePrimaryEntities(store, [
    { name: 'China Taiwan military clash 2027', type: 'topic', slug: 'china-taiwan-military-clash-2027' },
  ], catalog)

  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].created, false)
  assert.equal(resolved[0].entity.slug, 'china-taiwan')
  assert.equal(store.entities.length, 1, 'no new entity was created')
})

test('resolver drops banned source-object entities entirely', async () => {
  const store = new InMemoryEntityMemoryStore()
  const resolved = await resolverTesting.resolvePrimaryEntities(store, [
    { name: 'Polymarket', type: 'organization', slug: 'polymarket' },
  ], [])
  assert.equal(resolved.length, 0)
  assert.equal(store.entities.length, 0)
})

test('resolver normalizes new-entity types into the fixed vocabulary', async () => {
  const store = new InMemoryEntityMemoryStore()
  const resolved = await resolverTesting.resolvePrimaryEntities(store, [
    { name: 'United States', type: 'nation', slug: 'united-states' },
  ], [])
  assert.equal(resolved[0].entity.type, 'country')
})

// -------------------------------------------------------------- wiring ---

test('writeExtraction hands the provider a shortlist drawn from the stored catalog', async () => {
  const store = new InMemoryEntityMemoryStore()
  store.entities.push(FED, NVIDIA)

  let received: ExtractionCanon | undefined
  const provider = {
    extract: async (_packet: ResearchPacket, canon?: ExtractionCanon) => {
      received = canon
      return { primaryEntities: [], memories: [] } as EntityMemoryExtraction
    },
  }

  await writeExtraction(store, packet(), provider)

  assert.ok(received, 'canon was passed')
  assert.equal(received?.catalog.length, 2)
  assert.deepEqual(received?.shortlist.map((entity) => entity.slug), ['us-federal-reserve'], 'FOMC packet shortlists the Fed, not NVIDIA')
})
