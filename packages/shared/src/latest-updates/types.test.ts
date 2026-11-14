import assert from 'node:assert/strict'
import type { LatestUpdate, LatestUpdatesResponse } from './index.js'

// Compile-time checks run under `pnpm --filter @myboon/shared typecheck`;
// `tsx` only strips types, so the runtime asserts below cover the fixtures.

const empty: LatestUpdatesResponse = { updates: [] }

const oneItem: LatestUpdatesResponse = {
  updates: [
    {
      id: '01a1d784-2619-793f-b18c-1cf11c808941',
      entitySlug: 'bitcoin',
      entityName: 'Bitcoin',
      entityType: 'asset',
      headline: 'Bitcoin slides toward $74K',
      whatHappened: 'Bitcoin fell toward $74K.',
      howWeGotHere: 'It followed a hot CPI print.',
      whatToWatch: 'The Fed decision on Dec 10.',
      sources: [
        {
          itemId: '01a1d784-2619-793f-b18c-1cf11c808942',
          title: 'Bitcoin slides toward $74K as Fed signals a pause',
          link: 'https://example.com/bitcoin-74k',
          occurredAt: '2026-11-10T14:26:06+00:00',
        },
      ],
      publishedAt: '2026-11-14T01:00:00+00:00',
    },
  ],
}

// Internal fields must not be part of the type.
// @ts-expect-error `claims` is not returned
const withClaims: LatestUpdate = { ...oneItem.updates[0]!, claims: [] }
// @ts-expect-error `model` is not returned
const withModel: LatestUpdate = { ...oneItem.updates[0]!, model: 'glm-5.3-flash' }
// @ts-expect-error `run_id` is not returned
const withRunId: LatestUpdate = { ...oneItem.updates[0]!, run_id: 'x' }
// @ts-expect-error `visibility` is not returned
const withVisibility: LatestUpdate = { ...oneItem.updates[0]!, visibility: 'live' }
void [withClaims, withModel, withRunId, withVisibility]

// A required field cannot be dropped.
// @ts-expect-error `whatToWatch` is required
const missingField: LatestUpdate = { ...oneItem.updates[0]!, whatToWatch: undefined }
void missingField

function testEmptyResponseSatisfiesType(): void {
  assert.deepEqual(empty, { updates: [] })
}

function testDocumentedFieldsOnly(): void {
  assert.deepEqual(Object.keys(oneItem.updates[0]!).sort(), [
    'entityName', 'entitySlug', 'entityType', 'headline', 'howWeGotHere', 'id',
    'publishedAt', 'sources', 'whatHappened', 'whatToWatch',
  ])
  assert.deepEqual(Object.keys(oneItem.updates[0]!.sources[0]!).sort(), [
    'itemId', 'link', 'occurredAt', 'title',
  ])
}

testEmptyResponseSatisfiesType()
testDocumentedFieldsOnly()

console.log('Latest updates response type tests passed')
