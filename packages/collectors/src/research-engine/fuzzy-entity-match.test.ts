import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideFuzzyEntityMatch, fuzzyTypesCompatible, FUZZY_ATTACH_MIN_SIMILARITY, FUZZY_HOLD_MIN_SIMILARITY, FUZZY_MIN_KEY_LENGTH,
  type FuzzyEntityCandidate,
} from './fuzzy-entity-match'
import { entityIdentityKey } from '../entity-manager/identity-key'

const row = (name: string, similarity: number, type: string | null = 'event', id = name.toLowerCase().replace(/\W+/g, '-')): FuzzyEntityCandidate =>
  ({ id, name, aliases: [], summary: null, type, status: 'review', nameKey: entityIdentityKey(name), similarity })
const token = { name: 'TOKEN2049 Singapore 2026', type: 'event' }

test('#342 constants are the CTO bands', () => {
  assert.equal(FUZZY_ATTACH_MIN_SIMILARITY, 0.85)
  assert.equal(FUZZY_HOLD_MIN_SIMILARITY, 0.6)
  assert.equal(FUZZY_MIN_KEY_LENGTH, 6)
})

test('#342 band >= 0.85 with a compatible type offers the candidate (attach only via placement)', () => {
  for (const similarity of [FUZZY_ATTACH_MIN_SIMILARITY, 0.9, 1]) {
    const d = decideFuzzyEntityMatch(token, [row('Token2049 Singapore', similarity)])
    assert.equal(d.kind, 'attach_candidate', String(similarity))
  }
})

test('#342 band 0.6 to < 0.85 is always a hold, never an attach', () => {
  for (const similarity of [FUZZY_HOLD_MIN_SIMILARITY, 0.7, 0.8499]) {
    const d = decideFuzzyEntityMatch(token, [row('Token2049 Singapore', similarity)])
    assert.equal(d.kind, 'hold', String(similarity))
  }
})

test('#342 below 0.6 creates normally', () => {
  const d = decideFuzzyEntityMatch(token, [row('Token2049 Singapore', 0.5999)])
  assert.deepEqual(d, { kind: 'none', reason: 'no_candidate' })
})

test('#342 short keys skip fuzzy entirely (USDC/USDG, Arc/Arcus)', () => {
  assert.deepEqual(decideFuzzyEntityMatch({ name: 'USDC', type: 'asset' }, [row('USDG', 0.9, 'asset')]), { kind: 'none', reason: 'short_key' })
  assert.deepEqual(decideFuzzyEntityMatch({ name: 'Arcus Network', type: 'network' }, [row('Arc', 0.9, 'network')]), { kind: 'none', reason: 'no_candidate' })
})

test('#342 attach band with an incompatible type is a hold', () => {
  const d = decideFuzzyEntityMatch({ name: 'Zhipu Holdings', type: 'company' }, [row('Zhipu Holding', 0.9, 'country')])
  assert.equal(d.kind, 'hold')
  if (d.kind === 'hold') assert.match(d.reason, /incompatible type/)
})

test('#342 grounding compatibility: unknown or unclassified types are compatible, mapped kinds must match', () => {
  assert.equal(fuzzyTypesCompatible('company', 'organization'), true)
  assert.equal(fuzzyTypesCompatible('country', 'geo'), true)
  assert.equal(fuzzyTypesCompatible('asset', 'person'), false)
  assert.equal(fuzzyTypesCompatible(null, 'person'), true)
  assert.equal(fuzzyTypesCompatible('project', 'person'), true)
  assert.equal(fuzzyTypesCompatible('person', null), true)
})

test('#342 two attach-band matches are ambiguous and hold', () => {
  const d = decideFuzzyEntityMatch(token, [row('Token2049 Singapore', 0.9, 'event', 'a'), row('TOKEN 2049 Singapore', 0.88, 'event', 'b')])
  assert.equal(d.kind, 'hold')
})

test('#342 an equal name_key is the exact path, never fuzzy', () => {
  assert.deepEqual(decideFuzzyEntityMatch({ name: 'Bitcoin (BTC)', type: 'asset' }, [row('Bitcoin', 1, 'asset')]), { kind: 'none', reason: 'no_candidate' })
})

test('#342 the highest attach-band candidate wins over hold-band ones', () => {
  const d = decideFuzzyEntityMatch(token, [row('Token2049', 0.7), row('Token2049 Singapore', 0.86)])
  assert.equal(d.kind, 'attach_candidate')
  if (d.kind === 'attach_candidate') assert.equal(d.candidate.name, 'Token2049 Singapore')
})
