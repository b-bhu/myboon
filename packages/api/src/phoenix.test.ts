import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireLimitPriceUsd } from './phoenix.js'

test('requireLimitPriceUsd returns a defined price unchanged', () => {
  assert.equal(requireLimitPriceUsd('101.5'), '101.5')
})

test('requireLimitPriceUsd fails loudly when price is undefined', () => {
  assert.throws(() => requireLimitPriceUsd(undefined), /priceUsd is missing/)
})
