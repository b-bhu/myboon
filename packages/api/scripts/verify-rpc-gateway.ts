/** Read-only smoke check against an ALREADY RUNNING API. Never starts a server. */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')
const wallet = process.argv[3]
const solanaProvider = process.env.SOLANA_RPC_URL?.trim()
  || process.env.HELIUS_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com'
const results: { check: string; status: 'pass' | 'fail'; detail?: unknown }[] = []

async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json() as { id?: unknown; result?: any; error?: unknown }
  if (!response.ok || body.error || body.id !== 1) throw new Error('RPC check failed')
  return body.result
}

async function check(name: string, run: () => Promise<unknown>) {
  try {
    results.push({ check: name, status: 'pass', detail: await run() })
  } catch {
    // Provider errors can contain endpoint credentials. Never log them here.
    results.push({ check: name, status: 'fail' })
    process.exitCode = 1
  }
}

function expect(condition: unknown) {
  if (!condition) throw new Error('Unexpected RPC result')
}

await Promise.all([
  check('Solana mainnet blockhash and account reads', async () => {
    const [blockhash, accounts] = await Promise.all([
      rpc(`${base}/rpc/solana`, 'getLatestBlockhash', [{ commitment: 'confirmed' }]),
      rpc(`${base}/rpc/solana`, 'getMultipleAccounts', [['So11111111111111111111111111111111111111112'], { encoding: 'base64' }]),
    ])
    expect(typeof blockhash?.value?.blockhash === 'string')
    expect(accounts?.value?.[0]?.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    return { blockhashAvailable: true, wrappedSolMintOwnerMatches: true }
  }),
  check('Solana devnet gateway', async () => {
    const result = await rpc(`${base}/rpc/solana-devnet`, 'getLatestBlockhash')
    expect(typeof result?.value?.blockhash === 'string')
    return { blockhashAvailable: true }
  }),
  check('Polygon chain, block and read-only contract call', async () => {
    const [chainId, block, decimals] = await Promise.all([
      rpc(`${base}/rpc/polygon`, 'eth_chainId'),
      rpc(`${base}/rpc/polygon`, 'eth_blockNumber'),
      rpc(`${base}/rpc/polygon`, 'eth_call', [{ to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', data: '0x313ce567' }, 'latest']),
    ])
    expect(chainId === '0x89' && /^0x[\da-f]+$/i.test(block) && BigInt(decimals) === 6n)
    return { chainId: 137, blockAvailable: true, usdcDecimals: 6 }
  }),
  check('Custodial signing method rejected', async () => {
    const response = await fetch(`${base}/rpc/polygon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'eth_sign', params: [] }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json() as { error?: { code?: number } }
    expect(response.status === 400 && body.error?.code === -32601)
    return { httpStatus: 400, rpcCode: -32601 }
  }),
  ...(wallet ? [check('Wallet balance agrees with independent direct provider read', async () => {
    const params = [wallet, { commitment: 'confirmed' }]
    const [gateway, direct] = await Promise.all([
      rpc(`${base}/rpc/solana`, 'getBalance', params),
      rpc(solanaProvider, 'getBalance', params),
    ])
    expect(Number.isSafeInteger(gateway?.value) && gateway.value === direct?.value)
    return { wallet, lamports: gateway.value, matched: true }
  })] : []),
])

await check('Same-port Solana subscribe, notification and unsubscribe', () => new Promise((resolve, reject) => {
  const url = new URL(`${base}/rpc/solana`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url)
  let subscription: number | undefined
  let notified = false
  const timer = setTimeout(() => finish(false), 15_000)
  let finished = false
  function finish(ok: boolean) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    socket.close()
    if (ok) resolve({ samePort: true, slotNotificationReceived: true, unsubscribed: true })
    else reject(new Error('WebSocket check failed'))
  }
  socket.on('open', () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'slotSubscribe', params: [] })))
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())
      if (message.id === 10 && Number.isSafeInteger(message.result)) subscription = message.result
      if (message.method === 'slotNotification' && subscription !== undefined && !notified) {
        notified = true
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'slotUnsubscribe', params: [subscription] }))
      }
      if (message.id === 11) finish(message.result === true && notified)
      if (message.error) finish(false)
    } catch { finish(false) }
  })
  socket.once('error', () => finish(false))
  socket.once('close', () => finish(false))
}))

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2))
