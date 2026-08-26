import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import { Hono } from 'hono'
import {
  deriveBeaconDepositWalletAddress,
  isDeployedContractCode,
} from '../deposit-wallet.js'
import { sessions } from '../sessions.js'
import { registerSessionRoutes } from './session.js'

const KNOWN_SIGNER = '0xDd79A1287e691A3f0eD3CFeeD72C67b6c2851E40'
const KNOWN_BEACON_WALLET = '0x9f8d7D8a7ce6d1B34735e8db1d107ef92A0cEE59'

let app: Hono
let code = '0x6000'
let checkedAddresses: string[] = []

function proofMessage(address: string, timestamp: number): string {
  return [
    'myboon:predict:server-session',
    `address:${address.toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}

async function authBody(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  const timestamp = Date.now()
  return {
    polygonAddress: wallet.address,
    authTimestamp: timestamp,
    authSignature: await wallet.signMessage(proofMessage(wallet.address, timestamp)),
    creds: { key: 'key', secret: 'secret', passphrase: 'passphrase' },
    knownDepositWalletAddress: deriveBeaconDepositWalletAddress(wallet.address),
    ...overrides,
  }
}

beforeEach(() => {
  sessions.clear()
  code = '0x6000'
  checkedAddresses = []
  app = new Hono()
  registerSessionRoutes(app, {
    getCode: async (address) => {
      checkedAddresses.push(address)
      return code
    },
  })
})

describe('beacon Deposit Wallet derivation', () => {
  test('matches the current Polymarket beacon address for the reported signer', () => {
    assert.equal(deriveBeaconDepositWalletAddress(KNOWN_SIGNER), KNOWN_BEACON_WALLET)
  })

  test('recognizes deployed and empty contract code', () => {
    assert.equal(isDeployedContractCode('0x6000'), true)
    assert.equal(isDeployedContractCode('0x'), false)
    assert.equal(isDeployedContractCode('0x0000'), false)
  })
})

describe('POST /auth Deposit Wallet validation', () => {
  test('requires the SDK-resolved Deposit Wallet address', async () => {
    const wallet = Wallet.createRandom()
    const body = await authBody(wallet)
    delete (body as any).knownDepositWalletAddress

    const res = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    assert.equal(res.status, 400)
    assert.equal(checkedAddresses.length, 0)
    assert.equal(sessions.has(wallet.address.toLowerCase()), false)
  })

  test('rejects an address that does not match the signed EOA', async () => {
    const wallet = Wallet.createRandom()
    const otherWallet = Wallet.createRandom()
    const body = await authBody(wallet, {
      knownDepositWalletAddress: deriveBeaconDepositWalletAddress(otherWallet.address),
    })

    const res = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    assert.equal(res.status, 400)
    assert.equal(checkedAddresses.length, 0)
    assert.equal(sessions.has(wallet.address.toLowerCase()), false)
  })

  test('returns a clear setup error when the matching wallet is not deployed', async () => {
    const wallet = Wallet.createRandom()
    code = '0x'

    const res = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await authBody(wallet)),
    })
    const payload = await res.json() as { detail?: string }

    assert.equal(res.status, 409)
    assert.match(payload.detail ?? '', /not deployed/i)
    assert.equal(sessions.has(wallet.address.toLowerCase()), false)
  })

  test('registers a session directly for a matching deployed wallet', async () => {
    const wallet = Wallet.createRandom()
    const expected = deriveBeaconDepositWalletAddress(wallet.address).toLowerCase()

    const res = await app.request('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await authBody(wallet)),
    })
    const payload = await res.json() as Record<string, unknown>

    assert.equal(res.status, 200)
    assert.deepEqual(checkedAddresses, [expected])
    assert.equal(payload.depositWalletAddress, expected)
    assert.equal(payload.tradingAddress, expected)
    assert.equal(payload.walletMode, 'deposit_wallet')
    assert.equal('signatureRequest' in payload, false)
    assert.equal(sessions.get(wallet.address.toLowerCase())?.depositWalletAddress, expected)
  })
})

describe('GET /session/:polygonAddress account discovery', () => {
  test('reports a deployed account without an in-memory session', async () => {
    const wallet = Wallet.createRandom()
    const expected = deriveBeaconDepositWalletAddress(wallet.address).toLowerCase()

    const res = await app.request(`/session/${wallet.address}`)
    const payload = await res.json() as Record<string, unknown>

    assert.equal(res.status, 200)
    assert.equal(payload.hasAccount, true)
    assert.equal(payload.sessionLive, false)
    assert.equal(payload.depositWalletAddress, expected)
    assert.deepEqual(checkedAddresses, [expected])
  })

  test('reports no account when the derived wallet has no code', async () => {
    const wallet = Wallet.createRandom()
    code = '0x'

    const res = await app.request(`/session/${wallet.address}`)
    const payload = await res.json() as Record<string, unknown>

    assert.equal(res.status, 200)
    assert.equal(payload.hasAccount, false)
    assert.equal(payload.sessionLive, false)
    assert.equal(payload.depositWalletAddress, null)
  })
})
