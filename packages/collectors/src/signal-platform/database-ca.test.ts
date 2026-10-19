import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseCaConfigError, normalizeDatabaseCa } from './database-ca'
import { TEST_CA_PEM, TEST_CA_PEM_2 } from './test-fixtures/database-ca-fixture'

const SETTING = 'MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA'
const BUNDLE = `${TEST_CA_PEM}\n${TEST_CA_PEM_2}`

test('a correctly formatted PEM comes back byte-identical to the trimmed input', () => {
  assert.equal(normalizeDatabaseCa(SETTING, TEST_CA_PEM), TEST_CA_PEM)
  assert.equal(normalizeDatabaseCa(SETTING, BUNDLE), BUNDLE)
  assert.equal(normalizeDatabaseCa(SETTING, `\n ${TEST_CA_PEM} \n`), TEST_CA_PEM)
})

test('literal \\n and \\r\\n sequences are unescaped into the real multi-line PEM', () => {
  assert.equal(normalizeDatabaseCa(SETTING, TEST_CA_PEM.replaceAll('\n', '\\n')), TEST_CA_PEM)
  assert.equal(normalizeDatabaseCa(SETTING, TEST_CA_PEM.replaceAll('\n', '\\r\\n')), TEST_CA_PEM)
  assert.equal(normalizeDatabaseCa(SETTING, BUNDLE.replaceAll('\n', '\\n')), BUNDLE)
})

test('a valid bundle plus trailing text returns the normalised text unchanged', () => {
  // OpenSSL bundles accept comment or header lines between certificates, so
  // trailing junk after a real certificate block no longer invalidates it.
  const withJunk = `${TEST_CA_PEM}\ntrailing junk`
  assert.equal(normalizeDatabaseCa(SETTING, withJunk), withJunk)
})

test('unset or whitespace-only settings normalise to null', () => {
  for (const empty of [undefined, null, '', '   ', '\n\t']) {
    assert.equal(normalizeDatabaseCa(SETTING, empty), null)
  }
})

test('invalid settings throw DatabaseCaConfigError naming the setting without leaking the value', () => {
  const bodyLine = TEST_CA_PEM.split('\n')[1]!
  const slice40 = bodyLine.slice(0, 40)
  const garbageBase64 = '-----BEGIN CERTIFICATE-----\nnot!real!base64\n-----END CERTIFICATE-----'
  for (const bad of ['not a cert', garbageBase64, slice40, TEST_CA_PEM.slice(0, 80)]) {
    assert.throws(
      () => normalizeDatabaseCa(SETTING, bad),
      (error: unknown) => {
        if (!(error instanceof DatabaseCaConfigError)) return false
        return error.name === 'DatabaseCaConfigError'
          && error.message.includes(SETTING)
          && !error.message.includes(bad)
          && !error.message.includes(slice40)
          && !error.message.includes('-----BEGIN CERTIFICATE-----')
          && error.cause === undefined
      },
    )
  }
})