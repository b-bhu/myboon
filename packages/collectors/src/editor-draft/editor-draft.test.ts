import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHermesEditorDraftPrompt, HermesEditorDraftProvider } from './hermes-editor'
import type { GenerateStructuredRequest } from '../inference-gateway'
import { buildEntityDraftBundles } from './input-builder'
import { normalizeEditorDraftDecision, parseAgentEditorDraftResponse, sourceMemoryHash } from './normalizer'
import { runEditorDraft } from './runner'
import type { EntityMemoryRecord, EntityRecord } from '../entity-manager/types'
import type {
  AgentEditorDraftDecision,
  EditorDraftInput,
  EditorDraftProvider,
  EditorDraftRecord,
  EditorDraftStore,
  EntityDraftBundle,
  FetchEditorDraftBundlesOptions,
  PriorEditorDraft,
} from './types'

function entity(id: string, slug: string, name: string): EntityRecord {
  return {
    id,
    slug,
    name,
    type: 'organization',
    aliases: [name],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  }
}

function memory(id: string, entityId: string, title: string, observedAt: string): EntityMemoryRecord {
  return {
    id,
    entity_id: entityId,
    source: 'polymarket',
    source_area: 'markets',
    source_type: 'market_signal',
    source_ref_id: `slug-${id}`,
    source_research_id: `research-${id}`,
    memory_type: 'market_signal',
    title,
    summary: `${title} summary`,
    body: null,
    event_at: observedAt,
    observed_at: observedAt,
    confidence: 0.8,
    evidence: [],
    mentions: [],
    metrics: {},
    context: {},
    created_at: observedAt,
    updated_at: observedAt,
  }
}

function memoryWrittenAt(
  id: string,
  entityId: string,
  title: string,
  observedAt: string,
  createdAt: string
): EntityMemoryRecord {
  return {
    ...memory(id, entityId, title, observedAt),
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function priorDraft(entityId: string, sourceMemoryIds: string[], angle: string): PriorEditorDraft {
  return {
    id: `draft-${sourceMemoryIds.join('-')}`,
    entity_id: entityId,
    source_memory_ids: sourceMemoryIds,
    source_memory_hash: sourceMemoryHash(sourceMemoryIds),
    action: 'draft_post',
    status: 'drafted',
    title: angle,
    angle,
    summary: `${angle} summary`,
    reasoning: 'Prior editorial decision.',
    reason_codes: ['prior_angle'],
    created_at: '2026-06-20T00:00:00.000Z',
  }
}

class StaticProvider implements EditorDraftProvider {
  constructor(private readonly action: string) {}

  async decide(bundle: EntityDraftBundle) {
    return {
      action: this.action,
      source_memory_ids: [bundle.newMemories[0].id],
      title: 'Internal draft',
      angle: 'A distinct angle',
      reasoning: 'The new memory changes the lane.',
      evidence_quality: 'medium',
      confidence: 0.72,
    }
  }
}

class InMemoryDraftStore implements EditorDraftStore {
  rows: EditorDraftRecord[] = []

  constructor(private readonly bundles: EntityDraftBundle[]) {}

  async fetchBundles(_options: FetchEditorDraftBundlesOptions): Promise<EntityDraftBundle[]> {
    return this.bundles
  }

  async upsertDrafts(drafts: EditorDraftInput[]): Promise<EditorDraftRecord[]> {
    return drafts.map((draft) => {
      const existing = this.rows.find((row) => row.bundle_key === draft.bundle_key)
      if (existing) {
        Object.assign(existing, draft)
        return existing
      }
      const row = { id: `editor-draft-${this.rows.length + 1}`, ...draft }
      this.rows.push(row)
      return row
    })
  }
}

test('buildEntityDraftBundles groups recent unreviewed memories by entity', () => {
  const acme = entity('entity-1', 'acme', 'Acme')
  const reviewed = memory('memory-1', acme.id, 'Old WHOOP lane', '2026-06-20T00:00:00.000Z')
  const fresh = memory('memory-2', acme.id, 'WHOOP market moves again', '2026-06-30T00:00:00.000Z')
  const bundles = buildEntityDraftBundles(
    [acme],
    [reviewed, fresh],
    [priorDraft(acme.id, [reviewed.id], 'WHOOP launch angle')],
    [],
    { recentMemoryLimit: 5, laneMemoryLimit: 10 }
  )

  assert.equal(bundles.length, 1)
  assert.equal(bundles[0].entity.id, acme.id)
  assert.deepEqual(bundles[0].newMemories.map((item) => item.id), [fresh.id])
  assert.deepEqual(bundles[0].memoryLane.map((item) => item.id), [fresh.id, reviewed.id])
  assert.deepEqual(bundles[0].publishedHistory, [])
})

test('buildEntityDraftBundles orders editor intake by memory created_at before observed_at', () => {
  const acme = entity('entity-1', 'acme', 'Acme')
  const oldEventNewWrite = memoryWrittenAt(
    'memory-1',
    acme.id,
    'Old event researched later',
    '2026-05-01T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z'
  )
  const newerEventOlderWrite = memoryWrittenAt(
    'memory-2',
    acme.id,
    'Newer event written earlier',
    '2026-06-30T00:00:00.000Z',
    '2026-06-30T00:00:00.000Z'
  )

  const bundles = buildEntityDraftBundles(
    [acme],
    [newerEventOlderWrite, oldEventNewWrite],
    [],
    [],
    { recentMemoryLimit: 5, laneMemoryLimit: 10 }
  )

  assert.deepEqual(bundles[0].newMemories.map((item) => item.id), [oldEventNewWrite.id, newerEventOlderWrite.id])
  assert.deepEqual(bundles[0].memoryLane.map((item) => item.id), [oldEventNewWrite.id, newerEventOlderWrite.id])
})

test('buildEntityDraftBundles excludes directly reviewed memories even when prior drafts are capped out', () => {
  const acme = entity('entity-1', 'acme', 'Acme')
  const reviewed = memoryWrittenAt(
    'memory-1',
    acme.id,
    'Already reviewed lane memory',
    '2026-06-20T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z'
  )
  const fresh = memoryWrittenAt(
    'memory-2',
    acme.id,
    'Fresh lane memory',
    '2026-06-30T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z'
  )

  const bundles = buildEntityDraftBundles(
    [acme],
    [reviewed, fresh],
    [],
    [],
    {
      recentMemoryLimit: 5,
      laneMemoryLimit: 10,
      reviewedMemoryIds: new Set([reviewed.id]),
    }
  )

  assert.deepEqual(bundles[0].newMemories.map((item) => item.id), [fresh.id])
  assert.deepEqual(bundles[0].memoryLane.map((item) => item.id), [fresh.id, reviewed.id])
})

test('buildHermesEditorDraftPrompt excludes new memories from prior memory lane payload', async () => {
  const acme = entity('entity-1', 'acme', 'Acme')
  const prior = memory('memory-1', acme.id, 'Prior memory', '2026-06-20T00:00:00.000Z')
  const fresh = memory('memory-2', acme.id, 'Fresh memory', '2026-06-30T00:00:00.000Z')
  const bundle = buildEntityDraftBundles(
    [acme],
    [prior, fresh],
    [],
    [],
    { recentMemoryLimit: 1, laneMemoryLimit: 10 }
  )[0]

  const prompt = await buildHermesEditorDraftPrompt(bundle)
  const bundleMarker = prompt.indexOf('## Entity Bundle')
  const payload = JSON.parse(prompt.slice(prompt.indexOf('{', bundleMarker))) as {
    new_memories: Array<{ id: string }>
    prior_memory_lane: Array<{ id: string }>
  }

  assert.deepEqual(payload.new_memories.map((item) => item.id), [fresh.id])
  assert.deepEqual(payload.prior_memory_lane.map((item) => item.id), [prior.id])
})

test('editor draft uses the central tool-less structured gateway workload', async () => {
  const acme = entity('entity-1', 'acme', 'Acme')
  const fresh = memory('memory-2', acme.id, 'Fresh memory', '2026-06-30T00:00:00.000Z')
  const bundle = buildEntityDraftBundles([acme], [fresh], [], [], { recentMemoryLimit: 1, laneMemoryLimit: 10 })[0]!
  let request: GenerateStructuredRequest<{ decisions: AgentEditorDraftDecision[] }> | undefined
  const provider = new HermesEditorDraftProvider({
    gateway: {
      async generateStructured(input) {
        request = input as GenerateStructuredRequest<{ decisions: AgentEditorDraftDecision[] }>
        return {
          value: { decisions: [{ action: 'watch', reasoning: 'Needs time.' }] } as typeof input extends GenerateStructuredRequest<infer T> ? T : never,
          telemetry: {} as never,
        }
      },
    },
  })
  assert.equal((await provider.decide(bundle)).action, 'watch')
  assert.equal(request?.workload, 'editor.draft')
  assert.equal(request?.budget.maxToolCalls, 0)
  assert.equal('tools' in (request as object), false)
  assert.throws(() => new HermesEditorDraftProvider({ toolsets: 'browser' }), /tool-less/)
})

test('parseAgentEditorDraftResponse extracts fenced JSON and normalizes actions', () => {
  const parsed = parseAgentEditorDraftResponse(`Here is JSON:\n\`\`\`json\n${JSON.stringify({
    decisions: [{ action: 'skip_repetitive', source_memory_ids: ['memory-1'], reasoning: 'Repeated angle.' }],
  })}\n\`\`\``)

  assert.equal(parsed.decisions[0].action, 'skip_repetitive')

  const acme = entity('entity-1', 'acme', 'Acme')
  const fresh = memory('memory-2', acme.id, 'Fresh memory', '2026-06-30T00:00:00.000Z')
  const bundle = buildEntityDraftBundles(
    [acme],
    [fresh],
    [],
    [],
    { recentMemoryLimit: 5, laneMemoryLimit: 10 }
  )[0]
  const normalized = normalizeEditorDraftDecision({ action: 'bad_action', reasoning: 'Unknown.' }, bundle)

  assert.equal(normalized.action, 'needs_more_research')
  assert.equal(normalized.status, 'needs_more_research')
  assert.deepEqual(normalized.sourceMemoryIds, [fresh.id])
})

test('editor normalization emits an integer priority for the public feed contract', () => {
  const acme = entity('entity-1', 'acme', 'Acme')
  const fresh = memory('memory-2', acme.id, 'Fresh memory', '2026-06-30T00:00:00.000Z')
  const bundle = buildEntityDraftBundles(
    [acme], [fresh], [], [], { recentMemoryLimit: 5, laneMemoryLimit: 10 }
  )[0]

  const normalized = normalizeEditorDraftDecision({
    action: 'draft_post', source_memory_ids: [fresh.id], priority: 0.7,
  }, bundle)

  assert.equal(normalized.priority, 1)
})

test('runEditorDraft writes idempotently by source memory bundle', async () => {
  const acme = entity('entity-1', 'acme', 'Acme')
  const fresh = memory('memory-1', acme.id, 'New market signal', '2026-06-30T00:00:00.000Z')
  const bundle = buildEntityDraftBundles(
    [acme],
    [fresh],
    [],
    [],
    { recentMemoryLimit: 5, laneMemoryLimit: 10 }
  )[0]
  const store = new InMemoryDraftStore([bundle])
  const provider = new StaticProvider('draft_post')

  await runEditorDraft({} as any, null, { store, provider, now: '2026-07-01T00:00:00.000Z' })
  await runEditorDraft({} as any, null, { store, provider, now: '2026-07-01T00:01:00.000Z' })

  assert.equal(store.rows.length, 1)
  assert.equal(store.rows[0].action, 'draft_post')
  assert.deepEqual(store.rows[0].source_memory_ids, [fresh.id])
})

test('realistic repeated entity lane can be skipped as repetitive', () => {
  const taiwan = entity('entity-1', 'china-taiwan', 'China-Taiwan')
  const prior = memory('memory-1', taiwan.id, 'China-Taiwan drills raise market attention', '2026-06-22T00:00:00.000Z')
  const fresh = memory('memory-2', taiwan.id, 'Another China-Taiwan tension market appears', '2026-06-30T00:00:00.000Z')
  const bundle = buildEntityDraftBundles(
    [taiwan],
    [prior, fresh],
    [priorDraft(taiwan.id, [prior.id], 'China-Taiwan tension markets are crowded')],
    [],
    { recentMemoryLimit: 5, laneMemoryLimit: 10 }
  )[0]

  const normalized = normalizeEditorDraftDecision({
    action: 'skip_repetitive',
    source_memory_ids: [fresh.id],
    reasoning: 'The new memory repeats a prior China-Taiwan angle without a new catalyst.',
    reason_codes: ['repeats_prior_angle'],
    evidence_quality: 'medium',
  }, bundle)

  assert.equal(normalized.action, 'skip_repetitive')
  assert.equal(normalized.status, 'skipped')
  assert.deepEqual(normalized.sourceMemoryIds, [fresh.id])
})
