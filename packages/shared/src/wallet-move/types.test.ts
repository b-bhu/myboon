import assert from 'node:assert/strict'
import type {
  WalletMoveQuote,
  WalletMoveQuoteFees,
  WalletMoveQuoteLeg,
  WalletMoveQuoteResult,
  WalletMoveRelayStatus,
  WalletMoveState,
  WalletMoveStatus,
} from './index.js'

// Compile-time checks run under `pnpm --filter @myboon/shared typecheck`;
// `tsx` only strips types, so the runtime asserts below cover the fixtures.
// Fixture values are the #724 spike's live 2-USDC Solana -> Base quote.

const source: WalletMoveQuoteLeg = {
  chainId: 792703809,
  currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '2000000',
  amountUsd: '2.00',
}

const destination: WalletMoveQuoteLeg = {
  chainId: 8453,
  currency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  amount: '1977768',
  amountUsd: '1.977768',
}

const fees: WalletMoveQuoteFees = {
  executionUsd: '0.0220',
  swapUsd: '0.000232',
}

const quote: WalletMoveQuote = {
  requestId: '0x1795268589d262510c06f679d578b648cd110270c84894c3e7017cb3755fa4bd',
  source,
  destination,
  fees,
  timeEstimateSeconds: 1,
  step: { kind: 'transaction' },
}

const quoted: WalletMoveQuoteResult = { result: 'quoted', quote }
const notSupported: WalletMoveQuoteResult = {
  result: 'route_not_supported',
  sourceChainId: 137,
  destinationChainId: 792703809,
  reason: 'Move launches on Solana and Base. Polygon lands in a later release.',
}

const done: WalletMoveStatus = {
  requestId: quote.requestId,
  state: 'done',
  relayStatus: 'success',
  final: true,
  txHashes: ['0x274bc6c96bd6b1ff15e77b6a20e5e9e94f36a7a9'],
}

const refunded: WalletMoveStatus = {
  requestId: quote.requestId,
  state: 'failed',
  relayStatus: 'refund',
  final: true,
  txHashes: [],
}

const failedRefund: WalletMoveStatus = {
  requestId: quote.requestId,
  state: 'failed',
  relayStatus: 'failure',
  final: true,
  txHashes: [],
  refundFailReason: 'the refund transfer failed; the funds stay with the solver',
}

const unknownButPending: WalletMoveStatus = {
  requestId: quote.requestId,
  state: 'pending',
  relayStatus: 'unknown',
  final: false,
  txHashes: [],
  // Relay does not know this id yet; the app stops polling after its own cap.
  notFound: true,
}
// @ts-expect-error `notFound` is boolean
const numericNotFound: WalletMoveStatus = { ...unknownButPending, notFound: 1 }
void numericNotFound

// The eight Relay status values are exactly these.
const relayStatuses: WalletMoveRelayStatus[] = [
  'waiting', 'depositing', 'pending', 'submitted', 'success', 'failure', 'refund', 'unknown',
]
// @ts-expect-error `settled` is not a Relay status
const notARelayStatus: WalletMoveRelayStatus = 'settled'
void [relayStatuses, notARelayStatus]

// The mapped state has exactly three values.
const states: WalletMoveState[] = ['pending', 'done', 'failed']
// @ts-expect-error the mapped state has exactly three values
const notAState: WalletMoveState = 'queued'
void [states, notAState]

// A required quote field cannot be dropped.
// @ts-expect-error `timeEstimateSeconds` is required
const missingTime: WalletMoveQuote = { ...quote, timeEstimateSeconds: undefined }
void missingTime

// Amounts and fee values are decimal strings, never numbers.
// @ts-expect-error `amount` is a decimal string
const numericAmount: WalletMoveQuoteLeg = { ...source, amount: 1000000 }
// @ts-expect-error `swapUsd` is a decimal string
const numericFee: WalletMoveQuoteFees = { ...fees, swapUsd: 0.022 }
void [numericAmount, numericFee]

// An app fee and origin gas are optional; when Relay prices them they are strings.
const withFees: WalletMoveQuoteFees = { ...fees, appUsd: '0.01', gas: '44154' }
// @ts-expect-error `appUsd` is a string or undefined
const numericAppFee: WalletMoveQuoteFees = { ...fees, appUsd: 0.01 }
void [withFees, numericAppFee]

// A quote result needs its `result` tag.
// @ts-expect-error a quote result needs its `result` tag
const untagged: WalletMoveQuoteResult = quote
void [quoted, notSupported, untagged]

function testQuoteFixtureDocumentedFieldsOnly(): void {
  assert.deepEqual(Object.keys(quote).sort(), [
    'destination', 'fees', 'requestId', 'source', 'step', 'timeEstimateSeconds',
  ])
  assert.deepEqual(Object.keys(source).sort(), ['amount', 'amountUsd', 'chainId', 'currency'])
  assert.deepEqual(Object.keys(fees).sort(), ['executionUsd', 'swapUsd'])
}

function testStatusFixtureDocumentedFieldsOnly(): void {
  assert.deepEqual(Object.keys(done).sort(), [
    'final', 'relayStatus', 'requestId', 'state', 'txHashes',
  ])
  assert.deepEqual(Object.keys(failedRefund).sort(), [
    'final', 'refundFailReason', 'relayStatus', 'requestId', 'state', 'txHashes',
  ])
}

function testSpikeFactsAreExpressible(): void {
  // Relay's statuses carry the eight raw values; the quote carries seconds.
  assert.equal(relayStatuses.length, 8)
  assert.equal(quote.timeEstimateSeconds, 1)
  // Final means polling stops: success here, and both refund flavours above.
  assert.equal(done.final, true)
  assert.equal(refunded.final, true)
  assert.equal(failedRefund.final, true)
  assert.equal(unknownButPending.final, false)
  assert.equal(unknownButPending.notFound, true)
  // Quote results are the two tagged arms only.
  assert.deepEqual(quoted, { result: 'quoted', quote })
  assert.equal(notSupported.result, 'route_not_supported')
}

testQuoteFixtureDocumentedFieldsOnly()
testStatusFixtureDocumentedFieldsOnly()
testSpikeFactsAreExpressible()

console.log('Wallet move type tests passed')
