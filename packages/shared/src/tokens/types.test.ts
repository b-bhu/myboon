import assert from 'node:assert/strict'
import { isTokenResolveResponseV1 } from './types.js'

function testAcceptsCompleteAndPartialEnvelopes(): void {
  assert.equal(isTokenResolveResponseV1({
    v: 1,
    identities: [],
    partial: false,
    unresolved: [],
  }), true)
  assert.equal(isTokenResolveResponseV1({
    v: 1,
    identities: [],
    partial: true,
    unresolved: ['mint:pending'],
  }), true)
}

function testRejectsInvalidEnvelopeFields(): void {
  const valid = {
    v: 1,
    identities: [],
    partial: false,
    unresolved: [],
  }

  assert.equal(isTokenResolveResponseV1(null), false)
  assert.equal(isTokenResolveResponseV1(undefined), false)
  assert.equal(isTokenResolveResponseV1({ ...valid, v: 2 }), false)
  assert.equal(isTokenResolveResponseV1({ ...valid, identities: {} }), false)
  assert.equal(isTokenResolveResponseV1({ ...valid, partial: 'false' }), false)
  assert.equal(isTokenResolveResponseV1({ ...valid, unresolved: 'mint:pending' }), false)
}

testAcceptsCompleteAndPartialEnvelopes()
testRejectsInvalidEnvelopeFields()

console.log('Token response type tests passed')
