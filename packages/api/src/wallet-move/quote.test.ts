/**
 * #746 tests: POST /wallet/move/quote with injected fetch, as the issue's
 * Tests section names them — a valid quote mapped · unsupported chain gives
 * `route_not_supported` · bad input gives 400, including a Solana→Base
 * request whose recipient is not an EVM address · the recipient is sent
 * upstream · Relay 500 gives 502 · the key is sent in the header and appears
 * in no response and no log line — plus the quote-adjacent Done-means cases:
 * a missing key gives 503 and a Relay timeout or unusable answer gives 502.
 *
 * #747 adds the status polling route on the same factory and extends this
 * file, as that issue's Tests section names them: each of the eight Relay
 * statuses maps to the right shared state · an unknown id answers a
 * pending-style "not found yet" with `notFound: true` · a Relay error, an
 * unusable answer or a timeout gives 502 · a non-hex request id gives 400
 * before anything is sent upstream.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import {
  createWalletMoveRateLimiter,
  createWalletMoveRoutes,
  type WalletMoveFetch,
} from './routes.js'

// A fake key: the leak assertions in this file must never match it by accident.
const KEY = 'test-relay-key-746'
const SOL = '9WzDXwBbmkg8ZtS64B7gndLU7pvkP8nJEvF5mxqcYWBm'
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
// An explicit, valid EVM recipient on Base: what the body's recipientAddress
// carries for a Solana -> Base move (#746).
const BASE_RECIPIENT = '0x000000000000000000000000000000000000beef'
const REQUEST_ID = '0x1795268589d262510c06f679d578b648cd110270c84894c3e7017cb3755fa4bd'

function quoteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { chainId: 792703809, currency: USDC_SOL },
    destination: { chainId: 8453, currency: USDC_BASE },
    amount: '2000000',
    userAddress: SOL,
    ...overrides,
  }
}

// The spike's live 2-USDC Solana -> Base quote (docs.relay.link get-quote-v2
// schema), the same facts the shared types pin in #782.
function relayQuoteFixture(): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    steps: [{
      id: 'deposit',
      action: 'Confirm transaction in your wallet',
      description: 'Depositing funds to the relayer to execute the swap for USDC',
      kind: 'transaction',
      requestId: REQUEST_ID,
      items: [{ status: 'incomplete', data: { to: '9xyz11111111111111111111111111111111dep' } }],
    }],
    fees: {
      relayer: {
        currency: { chainId: 792703809, address: USDC_SOL, symbol: 'USDC', decimals: 6 },
        amount: '22000',
        amountFormatted: '0.022',
        amountUsd: '0.0220',
      },
      gas: {
        currency: { chainId: 792703809, symbol: 'SOL', decimals: 9 },
        amount: '44154',
        amountFormatted: '0.000044154',
        amountUsd: '0.0093',
      },
    },
    details: {
      currencyIn: {
        currency: { chainId: 792703809, address: USDC_SOL, symbol: 'USDC', decimals: 6 },
        amount: '2000000',
        amountFormatted: '2.00',
        amountUsd: '2.000000',
      },
      currencyOut: {
        currency: { chainId: 8453, address: USDC_BASE, symbol: 'USDC', decimals: 6 },
        amount: '1977768',
        amountFormatted: '1.977768',
        amountUsd: '1.977768',
      },
      expandedPriceImpact: {
        swap: { usd: '0.000232' },
        execution: { usd: '0.0220' },
        relay: { usd: '0.0220' },
        app: { usd: '0.010000' },
      },
      timeEstimate: 1,
    },
  }
}

const expectedQuote = () => ({
  result: 'quoted',
  quote: {
    requestId: REQUEST_ID,
    source: { chainId: 792703809, currency: USDC_SOL, amount: '2000000', amountUsd: '2.000000' },
    destination: { chainId: 8453, currency: USDC_BASE, amount: '1977768', amountUsd: '1.977768' },
    fees: { executionUsd: '0.0220', swapUsd: '0.000232', appUsd: '0.010000', gas: '44154' },
    timeEstimateSeconds: 1,
    step: (relayQuoteFixture().steps as unknown[]),
  },
})

// A mutateable Relay stub: tests flip `stub.state` between calls, per the
// loop's fake-upstream pattern (mutating the factory's return value only).
type RelayState = {
  status: number
  payload?: unknown
  rawBody?: string
  rejectName?: 'AbortError' | 'TypeError'
}
function createRelayStub(initial: Partial<RelayState> = {}) {
  const state: RelayState = { status: 200, ...initial }
  const calls: { url: string | URL; headers: Record<string, string>; body: unknown }[] = []
  const fetchImpl: WalletMoveFetch = async (url, init) => {
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      // GET status calls (#747) carry no body (null); quote calls carry JSON.
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    })
    if (state.rejectName) {
      throw Object.assign(new Error(state.rejectName === 'AbortError' ? 'aborted' : 'network down'), { name: state.rejectName })
    }
    const text = state.rawBody ?? JSON.stringify(state.payload)
    return new Response(text, { status: state.status, headers: { 'content-type': 'application/json' } })
  }
  return { state, calls, fetchImpl }
}

function appFor(stub: ReturnType<typeof createRelayStub>, routeOptions: Record<string, unknown> = {}) {
  const app = new Hono()
  app.route('/wallet', createWalletMoveRoutes({
    relayApiKey: KEY,
    fetchImpl: stub.fetchImpl,
    timeoutMs: 20,
    ...routeOptions,
  }))
  return app
}

async function post(app: InstanceType<typeof Hono>, body: unknown): Promise<Response> {
  return app.request('/wallet/move/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const NO_LOG: string[] = []
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = { error: console.error, info: console.info, log: console.log, warn: console.warn }
  const tee = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  console.error = tee as typeof console.error
  console.info = tee as typeof console.info
  console.log = tee as typeof console.log
  console.warn = tee as typeof console.warn
  return {
    lines,
    restore() {
      console.error = original.error
      console.info = original.info
      console.log = original.log
      console.warn = original.warn
      NO_LOG.push(...lines)
    },
  }
}

function assertKeyInNoList(texts: string[]): void {
  for (const text of texts) {
    assert.ok(!text.includes(KEY), `the Relay key leaked: ${text.slice(0, 300)}`)
  }
}

test('a valid quote is mapped and Relay is asked with POST and the key in the header', async () => {
  const stub = createRelayStub({ payload: relayQuoteFixture() })
  const capture = captureLogs()
  try {
    const response = await post(appFor(stub), quoteBody())
    assert.equal(response.status, 200)
    const responseText = await response.text()
    assert.deepEqual(JSON.parse(responseText), expectedQuote())
    // exactly one upstream call: Relay's quote endpoint, POST, key in header.
    assert.equal(stub.calls.length, 1)
    const call = stub.calls[0]!
    assert.equal(String(call.url), 'https://api.relay.link/quote/v2')
    assert.equal(call.headers['x-api-key'], KEY)
    assert.deepEqual(call.body, {
      user: SOL,
      recipient: SOL,
      originChainId: 792703809,
      originCurrency: USDC_SOL,
      destinationChainId: 8453,
      destinationCurrency: USDC_BASE,
      amount: '2000000',
      tradeType: 'EXACT_INPUT',
    })
    // The mapped answer itself carries the key nowhere.
    assertKeyInNoList([responseText])
  } finally {
    capture.restore()
  }
  assertKeyInNoList([...capture.lines])
})

test('an explicit recipientAddress is sent upstream as recipient', async () => {
  const stub = createRelayStub({ payload: relayQuoteFixture() })
  const response = await post(appFor(stub), quoteBody({ recipientAddress: BASE_RECIPIENT }))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(await response.text()), expectedQuote())
  assert.equal(stub.calls.length, 1)
  const upstream = stub.calls[0]!.body as Record<string, unknown>
  assert.equal(upstream.recipient, BASE_RECIPIENT)
  assert.equal(upstream.user, SOL)
})

test('a quote Relay prices without an app fee maps without appUsd', async () => {
  const payload = relayQuoteFixture()
  ;(payload.details as Record<string, unknown>).expandedPriceImpact = {
    swap: { usd: '0.000232' },
    app: { usd: '0' },
  }
  const stub = createRelayStub({ payload })
  const response = await post(appFor(stub), quoteBody())
  assert.equal(response.status, 200)
  const body = await response.json() as { quote: { fees: Record<string, unknown> } }
  assert.equal(body.quote.fees.executionUsd, '0.0220')
  assert.equal(body.quote.fees.swapUsd, '0.000232')
  assert.equal(body.quote.fees.gas, '44154')
  assert.ok(!('appUsd' in body.quote.fees))
})

test('a route outside the launch scope answers route_not_supported and never calls Relay', async () => {
  const stub = createRelayStub({ payload: relayQuoteFixture() })
  for (const [sourceChainId, destinationChainId, userAddress] of [
    [137, 792703809, SOL],
    [8453, 10, USDC_BASE],
  ] as const) {
    const body = quoteBody({
      source: { chainId: sourceChainId, currency: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
      destination: { chainId: destinationChainId, currency: USDC_BASE },
      userAddress,
    })
    const response = await post(appFor(stub), body)
    assert.equal(response.status, 200, `${sourceChainId} -> ${destinationChainId}`)
    assert.deepEqual(await response.json(), {
      result: 'route_not_supported',
      sourceChainId,
      destinationChainId,
      reason: 'Move launches on Solana and Base for now. Pick one of those chains to start the move.',
    })
  }
  assert.equal(stub.calls.length, 0)
})

test('bad input gives 400 with { error, code } and never calls Relay', async () => {
  const stub = createRelayStub({ payload: relayQuoteFixture() })
  const badBodies: [string, unknown][] = [
    ['not JSON at all', '{oops'],
    ['no source', { destination: { chainId: 8453, currency: USDC_BASE }, amount: '1', userAddress: SOL }],
    ['string chain id', quoteBody({ source: { chainId: '792703809', currency: USDC_SOL } })],
    ['empty currency', quoteBody({ destination: { chainId: 8453, currency: '' } })],
    ['zero amount', quoteBody({ amount: '0' })],
    ['numeric amount', quoteBody({ amount: 2000000 })],
    ['negative amount', quoteBody({ amount: '-5' })],
    ['missing userAddress', quoteBody({ userAddress: undefined })],
    ['evm address on a solana source', quoteBody({ userAddress: USDC_BASE })],
    ['solana recipient on a base destination', quoteBody({ recipientAddress: SOL })],
  ]
  for (const [name, body] of badBodies) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body)
    const response = await post(appFor(stub), raw)
    assert.equal(response.status, 400, name)
    const json = await response.json() as { error: unknown; code: unknown }
    assert.equal(typeof json.error, 'string', name)
    assert.equal(typeof json.code, 'string', name)
    assert.ok(typeof json.code === 'string' && json.code.includes('INVALID'), name)
  }
  assert.equal(stub.calls.length, 0)
})

test('Relay failing, timing out or answering unusably gives 502 with nothing from Relay', async () => {
  const cases: {
    name: string
    initial: Partial<RelayState>
    forbidden?: string
    expectCode: string
  }[] = [
    { name: '500', initial: { status: 500, payload: { message: 'relay-body-secret-746', error: 'boom' } }, forbidden: 'relay-body-secret-746', expectCode: 'UPSTREAM_FAILED' },
    { name: 'not json', initial: { status: 200, rawBody: '<html>not json</html>' }, forbidden: 'html', expectCode: 'UPSTREAM_INVALID' },
    { name: 'half a quote', initial: { status: 200, payload: { requestId: REQUEST_ID } }, expectCode: 'UPSTREAM_INVALID' },
    { name: 'timeout', initial: { rejectName: 'AbortError' }, expectCode: 'UPSTREAM_TIMEOUT' },
    { name: 'unreachable', initial: { rejectName: 'TypeError' }, expectCode: 'UPSTREAM_UNAVAILABLE' },
  ]
  for (const item of cases) {
    const stub = createRelayStub(item.initial)
    const capture = captureLogs()
    let responseText = ''
    let response: Response
    try {
      response = await post(appFor(stub), quoteBody())
      responseText = await response.text()
    } finally {
      capture.restore()
    }
    assert.equal(response.status, 502, item.name)
    assert.equal(JSON.parse(responseText).code, item.expectCode, item.name)
    assertKeyInNoList([responseText, ...NO_LOG])
    if (item.forbidden) assert.ok(!responseText.includes(item.forbidden), `${item.name}: Relay's body leaked into the 502`)
  }
})

test('the key is sent in the header and appears in no response and no log line', async () => {
  const flows: { name: string; initial: Partial<RelayState>; body: unknown }[] = [
    { name: 'quoted', initial: { payload: relayQuoteFixture() }, body: quoteBody() },
    {
      name: 'relay 500', initial: { status: 500, payload: { message: `boom with key ${KEY}` } }, body: quoteBody(),
    },
    { name: 'not supported', initial: { payload: relayQuoteFixture() }, body: quoteBody({ destination: { chainId: 10, currency: '0x0000000000000000000000000000000000000000' } }) },
    { name: 'bad input', initial: { payload: relayQuoteFixture() }, body: { source: {} } },
  ]
  const texts: string[] = []
  for (const flow of flows) {
    const stub = createRelayStub(flow.initial)
    const capture = captureLogs()
    try {
      const response = await post(appFor(stub), flow.body)
      texts.push(await response.text())
    } finally {
      capture.restore()
    }
  }
  assertKeyInNoList(texts)
  assertKeyInNoList(NO_LOG)
})

test('a missing key returns 503 and never calls Relay', async () => {
  const stub = createRelayStub({ payload: relayQuoteFixture() })
  const app = new Hono()
  app.route('/wallet', createWalletMoveRoutes({ fetchImpl: stub.fetchImpl, timeoutMs: 20 }))
  const response = await post(app, quoteBody())
  assert.equal(response.status, 503)
  const json = await response.json() as { error: string; code: string }
  assert.equal(json.code, 'NOT_CONFIGURED')
  assert.equal(typeof json.error, 'string')
  assert.equal(stub.calls.length, 0)
})

test('requests rate limit per identity with the rpc pattern', async () => {
  const stub = createRelayStub({ payload: relayQuoteFixture() })
  const appForLimiter = new Hono()
  appForLimiter.route('/wallet', createWalletMoveRoutes({
    relayApiKey: KEY,
    fetchImpl: stub.fetchImpl,
    rateLimiter: createWalletMoveRateLimiter(1),
    timeoutMs: 20,
  }))
  const first = await post(appForLimiter, quoteBody())
  assert.equal(first.status, 200)
  const second = await post(appForLimiter, quoteBody())
  assert.equal(second.status, 429)
  const retryAfter = Number(second.headers.get('retry-after'))
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `retry-after must be seconds 1..60, was ${retryAfter}`)
  assert.equal(stub.calls.length, 1)
})

// #747: Relay status polling on the same factory. The payloads below are the
// #724 spike's live shapes — only `status`, `txHashes` and `refundFailReason`
// are read; nothing else in Relay's body reaches the response.

function relayStatusFixture(status: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { status, ...extras }
}

async function getStatus(app: InstanceType<typeof Hono>, requestId: string): Promise<Response> {
  return app.request(`/wallet/move/status/${requestId}`)
}

test('each of the eight Relay statuses maps to the right shared state, finals and details', async () => {
  const stub = createRelayStub()
  const app = appFor(stub)
  const cases: { name: string; status: string; extras: Record<string, unknown>; expected: Record<string, unknown> }[] = [
    {
      name: 'waiting (the spike live shape)', status: 'waiting', extras: { quoteCreatedAt: 1795268589460 },
      expected: { requestId: REQUEST_ID, state: 'pending', relayStatus: 'waiting', final: false, txHashes: [] },
    },
    {
      name: 'depositing', status: 'depositing', extras: {},
      expected: { requestId: REQUEST_ID, state: 'pending', relayStatus: 'depositing', final: false, txHashes: [] },
    },
    {
      name: 'pending', status: 'pending', extras: {},
      expected: { requestId: REQUEST_ID, state: 'pending', relayStatus: 'pending', final: false, txHashes: [] },
    },
    {
      name: 'submitted', status: 'submitted', extras: {},
      expected: { requestId: REQUEST_ID, state: 'pending', relayStatus: 'submitted', final: false, txHashes: [] },
    },
    {
      name: 'success carries the fill hashes', status: 'success', extras: { txHashes: ['0xdestinationfill747'] },
      expected: { requestId: REQUEST_ID, state: 'done', relayStatus: 'success', final: true, txHashes: ['0xdestinationfill747'] },
    },
    {
      name: 'failure stays pending', status: 'failure', extras: {},
      expected: { requestId: REQUEST_ID, state: 'pending', relayStatus: 'failure', final: false, txHashes: [] },
    },
    {
      name: 'failure with a failed refund is final', status: 'failure', extras: { refundFailReason: 'the refund transfer failed' },
      expected: {
        requestId: REQUEST_ID, state: 'failed', relayStatus: 'failure', final: true, txHashes: [],
        refundFailReason: 'the refund transfer failed',
      },
    },
    {
      name: 'refund (the spike live shape)', status: 'refund', extras: { revertReason: null },
      expected: { requestId: REQUEST_ID, state: 'failed', relayStatus: 'refund', final: true, txHashes: [] },
    },
  ]
  for (const item of cases) {
    stub.state.payload = relayStatusFixture(item.status, item.extras)
    const response = await getStatus(app, REQUEST_ID)
    assert.equal(response.status, 200, item.name)
    assert.deepEqual(JSON.parse(await response.text()), item.expected, item.name)
  }
  // Upstream shape, checked on the first call of the run: GET the status URL
  // with the id as the param, the key only in the header, no request body.
  assert.equal(stub.calls.length, cases.length)
  const call = stub.calls[0]!
  assert.equal(String(call.url), `https://api.relay.link/intents/status/v3?requestId=${REQUEST_ID}`)
  assert.equal(call.body, null)
  assert.equal(call.headers['x-api-key'], KEY)
  // A hashes line Relay does not report as an array of strings stays empty.
  stub.state.payload = relayStatusFixture('success', { txHashes: 'not-an-array' })
  const noHashesResponse = await getStatus(app, REQUEST_ID)
  assert.equal(noHashesResponse.status, 200)
  const noHashesBody = await noHashesResponse.json() as { txHashes: string[] }
  assert.deepEqual(noHashesBody.txHashes, [])
})

test('an unknown id answers a pending-style "not found yet" with notFound, not an error', async () => {
  const stub = createRelayStub({ payload: relayStatusFixture('unknown', { revertReason: null }) })
  const response = await getStatus(appFor(stub), REQUEST_ID)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(await response.text()), {
    requestId: REQUEST_ID,
    state: 'pending',
    relayStatus: 'unknown',
    final: false,
    txHashes: [],
    notFound: true,
  })
})

test('a request id that is not a hex string gives 400 and never calls Relay', async () => {
  const stub = createRelayStub({ payload: relayStatusFixture('pending') })
  for (const requestId of ['not-hex', '0xzz', '0x', 'X123', '0x--']) {
    const response = await getStatus(appFor(stub), requestId)
    assert.equal(response.status, 400, requestId)
    const json = await response.json() as { error: string; code: string }
    assert.equal(json.code, 'INVALID_REQUEST_ID', requestId)
    assert.equal(typeof json.error, 'string', requestId)
  }
  assert.equal(stub.calls.length, 0)
})

test('a Relay error, an unusable answer or a timeout gives 502 with nothing from Relay', async () => {
  const cases: { name: string; initial: Partial<RelayState>; forbidden?: string; expectCode: string }[] = [
    { name: '500', initial: { status: 500, payload: { message: 'relay-status-secret-747', error: 'boom' } }, forbidden: 'relay-status-secret-747', expectCode: 'UPSTREAM_FAILED' },
    { name: 'not json', initial: { status: 200, rawBody: '<html>not json</html>' }, expectCode: 'UPSTREAM_INVALID' },
    { name: 'no status word', initial: { status: 200, payload: { quoteCreatedAt: 1795268589460 } }, expectCode: 'UPSTREAM_INVALID' },
    { name: 'a status outside the eight', initial: { status: 200, payload: { status: 'settled' } }, expectCode: 'UPSTREAM_INVALID' },
    { name: 'timeout', initial: { rejectName: 'AbortError' }, expectCode: 'UPSTREAM_TIMEOUT' },
    { name: 'unreachable', initial: { rejectName: 'TypeError' }, expectCode: 'UPSTREAM_UNAVAILABLE' },
  ]
  for (const item of cases) {
    const stub = createRelayStub(item.initial)
    const response = await getStatus(appFor(stub), REQUEST_ID)
    const text = await response.text()
    assert.equal(response.status, 502, item.name)
    const json = JSON.parse(text) as { error: string; code: string }
    assert.equal(json.code, item.expectCode, item.name)
    assert.equal(typeof json.error, 'string', item.name)
    assert.ok(!text.includes(KEY), `${item.name}: the Relay key leaked into the 502`)
    if (item.forbidden) assert.ok(!text.includes(item.forbidden), `${item.name}: Relay's body leaked into the 502`)
  }
})

test('a missing key returns 503 on the status route too and never calls Relay', async () => {
  const stub = createRelayStub({ payload: relayStatusFixture('pending') })
  const app = new Hono()
  app.route('/wallet', createWalletMoveRoutes({ fetchImpl: stub.fetchImpl, timeoutMs: 20 }))
  const response = await getStatus(app, REQUEST_ID)
  assert.equal(response.status, 503)
  const json = await response.json() as { error: string; code: string }
  assert.equal(json.code, 'NOT_CONFIGURED')
  assert.equal(typeof json.error, 'string')
  assert.equal(stub.calls.length, 0)
})
