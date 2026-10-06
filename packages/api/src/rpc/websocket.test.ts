import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attachRpcWebSocketBridge,
  deriveWsUrl,
  type RpcWebSocketLike,
  type RpcWebSocketServerLike,
} from './websocket.js'
import { parseRpcPayload } from './policy.js'

class FakeSocket implements RpcWebSocketLike {
  readyState = 0
  bufferedAmount = 0
  readonly sent: string[] = []
  closeCode: number | undefined
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const once = (...args: any[]) => {
      const listeners = this.listeners.get(event)
      if (listeners) this.listeners.set(event, listeners.filter((entry) => entry !== once))
      listener(...args)
    }
    return this.on(event, once)
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    if (this.readyState === 3) return
    this.closeCode = code
    this.readyState = 3
    this.emit('close', code)
  }
}

class FakeWebSocketServer implements RpcWebSocketServerLike {
  readonly client = new FakeSocket()
  closed = false

  handleUpgrade(
    _request: unknown,
    _socket: unknown,
    _head: Buffer,
    callback: (client: RpcWebSocketLike) => void,
  ): void {
    this.client.open()
    callback(this.client)
  }

  close(): void {
    this.closed = true
  }
}

class FakeUpgradeServer {
  private listener: ((request: any, socket: { destroy: () => void }, head: Buffer) => void) | undefined
  on(_event: 'upgrade', listener: (request: any, socket: { destroy: () => void }, head: Buffer) => void): this {
    this.listener = listener
    return this
  }

  off(_event: 'upgrade', listener: (request: any, socket: { destroy: () => void }, head: Buffer) => void): this {
    if (this.listener === listener) this.listener = undefined
    return this
  }

  upgrade(path: string, remoteAddress = '10.0.0.4', headers: Record<string, string> = {}): { destroyed: boolean } {
    let destroyed = false
    this.listener?.({ url: path, headers, socket: { remoteAddress } }, { destroy: () => { destroyed = true } }, Buffer.alloc(0))
    return { destroyed }
  }
}

const endpoints = {
  solanaRpcUrl: 'https://helius.example/rpc?api-key=secret-key',
  solanaDevnetRpcUrl: 'https://devnet.example/rpc?api-key=dev-secret',
  polygonRpcUrl: 'https://polygon.example/rpc?key=polygon-secret',
}

test('derived websocket endpoints preserve provider path and query credentials server-side', () => {
  assert.equal(
    deriveWsUrl('https://helius.example/rpc/path?api-key=secret'),
    'wss://helius.example/rpc/path?api-key=secret',
  )
  assert.equal(deriveWsUrl('http://localhost:8899'), 'ws://localhost:8899/')
})

test('websocket policy permits subscriptions but rejects custodial/admin methods', () => {
  const allowed = parseRpcPayload({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: ['all'] }, 'solana')
  assert.ok(Array.isArray(allowed))
  const denied = parseRpcPayload({ jsonrpc: '2.0', id: 2, method: 'requestAirdrop', params: [] }, 'solana')
  assert.equal(Array.isArray(denied), false)
  if (!Array.isArray(denied)) assert.equal(denied.error.code, -32601)
})

test('websocket bridge flushes queued subscriptions, forwards unsubscribe and cleans up provider errors', () => {
  const upgradeServer = new FakeUpgradeServer()
  const bridgeServer = new FakeWebSocketServer()
  const upstream = new FakeSocket()
  let handshakeTimeout = 0
  const dispose = attachRpcWebSocketBridge(upgradeServer as never, {
    ...endpoints,
    upstreamHandshakeTimeoutMs: 1234,
    webSocketServerFactory: () => bridgeServer,
    webSocketFactory: (_url, options) => {
      handshakeTimeout = options.handshakeTimeout
      return upstream
    },
  })

  upgradeServer.upgrade('/rpc/solana')
  const subscribe = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: ['all'] })
  bridgeServer.client.emit('message', Buffer.from(subscribe), false)
  assert.deepEqual(upstream.sent, [])
  assert.equal(handshakeTimeout, 1234)

  upstream.open()
  assert.deepEqual(upstream.sent, [subscribe])
  const unsubscribe = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'logsUnsubscribe', params: [1] })
  bridgeServer.client.emit('message', Buffer.from(unsubscribe), false)
  assert.deepEqual(upstream.sent, [subscribe, unsubscribe])

  upstream.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'subscription', params: {} })))
  assert.equal(bridgeServer.client.sent.length, 1)
  upstream.emit('error', new Error('provider credentials must not escape'))
  assert.equal(bridgeServer.client.closeCode, 1011)
  dispose()
  assert.equal(bridgeServer.closed, true)
})

test('websocket bridge bounds backpressure in both directions and charges upgrades per source IP', () => {
  for (const direction of ['upstream', 'downstream']) {
    const firstUpgradeServer = new FakeUpgradeServer()
    const firstBridgeServer = new FakeWebSocketServer()
    const firstUpstream = new FakeSocket()
    const dispose = attachRpcWebSocketBridge(firstUpgradeServer as never, {
      ...endpoints,
      maxQueuedBytes: 4,
      webSocketServerFactory: () => firstBridgeServer,
      webSocketFactory: () => firstUpstream,
    })
    firstUpgradeServer.upgrade('/rpc/solana')
    firstUpstream.open()
    if (direction === 'upstream') {
      firstUpstream.bufferedAmount = 4
      firstBridgeServer.client.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe' })), false)
    } else {
      firstBridgeServer.client.bufferedAmount = 4
      firstUpstream.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 12 })))
    }
    assert.equal(firstBridgeServer.client.closeCode, 1009, direction)
    assert.equal(firstUpstream.closeCode, 1009, direction)
    dispose()
  }

  const limitedUpgradeServer = new FakeUpgradeServer()
  const limitedBridgeServer = new FakeWebSocketServer()
  const limitedUpstream = new FakeSocket()
  const limitedDispose = attachRpcWebSocketBridge(limitedUpgradeServer as never, {
    ...endpoints,
    rateLimiter: {
      consume: (() => {
        let uses = 0
        return () => ({ ok: uses++ === 0, retryAfterSeconds: 60 })
      })(),
    },
    webSocketServerFactory: () => limitedBridgeServer,
    webSocketFactory: () => limitedUpstream,
  })
  limitedUpgradeServer.upgrade('/rpc/solana', '10.0.0.5', { 'x-forwarded-for': 'spoofed-a' })
  const second = limitedUpgradeServer.upgrade('/rpc/solana', '10.0.0.5', { 'x-forwarded-for': 'spoofed-b', 'x-myboon-session': 'new-session' })
  assert.equal(second.destroyed, true)
  limitedDispose()
})

test('unknown or malformed upgrade paths close without opening a provider connection', () => {
  const server = new FakeUpgradeServer()
  let connections = 0
  const dispose = attachRpcWebSocketBridge(server as never, {
    ...endpoints,
    webSocketServerFactory: () => new FakeWebSocketServer(),
    webSocketFactory: () => {
      connections++
      return new FakeSocket()
    },
  })
  assert.equal(server.upgrade('/rpc/polygon').destroyed, true)
  assert.equal(server.upgrade('http://[').destroyed, true)
  assert.equal(connections, 0)
  dispose()
})
