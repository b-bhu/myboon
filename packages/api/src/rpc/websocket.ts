import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  isSubscriptionMethod,
  parseRpcPayload,
  rpcEndpointSecrets,
  rpcError,
  sanitizeRpcSecrets,
  type RpcNetwork,
} from './policy.js'
import { createRpcRateLimiter, type RpcRateLimiter, type RpcProxyEndpoints } from './routes.js'

export type RpcWebSocketEndpoints = RpcProxyEndpoints & {
  solanaWsRpcUrl?: string
  solanaDevnetWsRpcUrl?: string
}

export type RpcWebSocketOptions = RpcWebSocketEndpoints & {
  rateLimiter?: RpcRateLimiter
  trustForwardedHeaders?: boolean
  maxMessageBytes?: number
  maxQueuedBytes?: number
  upstreamHandshakeTimeoutMs?: number
  webSocketFactory?: RpcWebSocketFactory
  webSocketServerFactory?: RpcWebSocketServerFactory
}

export type RpcWebSocketLike = {
  readyState: number
  bufferedAmount: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  on: (event: string, listener: (...args: any[]) => void) => RpcWebSocketLike
  once: (event: string, listener: (...args: any[]) => void) => RpcWebSocketLike
}

export type RpcWebSocketFactory = (url: string, options: { handshakeTimeout: number }) => RpcWebSocketLike

export type RpcWebSocketServerLike = {
  handleUpgrade: (
    request: IncomingMessage,
    socket: unknown,
    head: Buffer,
    callback: (client: RpcWebSocketLike) => void,
  ) => void
  close: () => void
}

export type RpcWebSocketServerFactory = (options: { noServer: true; maxPayload: number }) => RpcWebSocketServerLike

type UpgradeServer = {
  on: (event: 'upgrade', listener: (request: IncomingMessage, socket: { destroy: () => void }, head: Buffer) => void) => unknown
  off: (event: 'upgrade', listener: (request: IncomingMessage, socket: { destroy: () => void }, head: Buffer) => void) => unknown
}

export function deriveWsUrl(httpUrl: string): string {
  const parsed = new URL(httpUrl)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return parsed.toString()
}

function endpointFor(network: RpcNetwork, options: RpcWebSocketOptions): string {
  if (network === 'solana-devnet') return options.solanaDevnetWsRpcUrl ?? deriveWsUrl(options.solanaDevnetRpcUrl)
  return options.solanaWsRpcUrl ?? deriveWsUrl(options.solanaRpcUrl)
}

function networkForPath(path: string): RpcNetwork | null {
  if (path === '/rpc/solana') return 'solana'
  if (path === '/rpc/solana-devnet') return 'solana-devnet'
  return null
}

function identity(request: IncomingMessage, trustForwardedHeaders: boolean): string {
  const headers = request.headers
  // Keep the quota key per source address. x-myboon-session is intentionally
  // excluded because it is supplied by the caller and must not reset quota.
  if (!trustForwardedHeaders) return request.socket.remoteAddress ?? 'unknown'
  const cloudflare = headers['cf-connecting-ip']
  const forwarded = headers['x-forwarded-for']
  return ((typeof cloudflare === 'string' ? cloudflare : cloudflare?.[0])
    ?? (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded?.[0]?.split(',')[0].trim())
    ?? request.socket.remoteAddress
    ?? 'unknown')
}

function sendJson(socket: RpcWebSocketLike, body: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify(body))
}

export function attachRpcWebSocketBridge(
  server: UpgradeServer,
  options: RpcWebSocketOptions,
): () => void {
  const maxMessageBytes = options.maxMessageBytes ?? 2 * 1024 * 1024
  const maxQueuedBytes = options.maxQueuedBytes ?? 2 * 1024 * 1024
  const limiter = options.rateLimiter ?? createRpcRateLimiter()
  const createServer = options.webSocketServerFactory
    ?? ((serverOptions) => new WebSocketServer(serverOptions) as unknown as RpcWebSocketServerLike)
  const createSocket = options.webSocketFactory
    ?? ((url, socketOptions) => new WebSocket(url, socketOptions) as unknown as RpcWebSocketLike)
  const wss = createServer({ noServer: true, maxPayload: maxMessageBytes })

  const onUpgrade = (request: IncomingMessage, socket: { destroy: () => void }, head: Buffer) => {
    let path: string
    try { path = new URL(request.url ?? '/', 'http://rpc.local').pathname } catch {
      socket.destroy()
      return
    }
    const network = networkForPath(path)
    if (!network) {
      socket.destroy()
      return
    }
    // Charge the upgrade before opening an upstream socket. This prevents
    // reconnect floods and idle sockets from bypassing the per-IP budget.
    const handshakeQuota = limiter.consume(identity(request, options.trustForwardedHeaders === true), 1)
    if (!handshakeQuota.ok) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket as never, head, (client) => {
      const upstream = createSocket(endpointFor(network, options), {
        handshakeTimeout: options.upstreamHandshakeTimeoutMs ?? 10_000,
      })
      let closed = false
      let queuedBytes = 0
      const queue: string[] = []
      const closeBoth = (code = 1000, reason = '') => {
        if (closed) return
        closed = true
        queue.length = 0
        queuedBytes = 0
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason)
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason)
      }
      const forward = (message: string) => {
        if (closed) return
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount + Buffer.byteLength(message) > maxQueuedBytes) return closeBoth(1009, 'RPC backpressure limit exceeded')
          upstream.send(message)
          return
        }
        if (queuedBytes + Buffer.byteLength(message) > maxQueuedBytes) return closeBoth(1009, 'RPC queue limit exceeded')
        queue.push(message)
        queuedBytes += Buffer.byteLength(message)
      }
      upstream.once('open', () => {
        while (queue.length > 0 && !closed) {
          const message = queue.shift()!
          queuedBytes -= Buffer.byteLength(message)
          forward(message)
        }
      })
      upstream.on('message', (data) => {
        if (client.readyState !== WebSocket.OPEN) return
        const messageBytes = Buffer.byteLength(data as Buffer)
        if (messageBytes > maxMessageBytes) return closeBoth(1009, 'RPC message too large')
        if (client.bufferedAmount + messageBytes > maxQueuedBytes) {
          return closeBoth(1009, 'RPC downstream backpressure limit exceeded')
        }
        const text = data.toString()
        client.send(sanitizeRpcSecrets(text, rpcEndpointSecrets(endpointFor(network, options))) as string)
      })
      upstream.once('error', () => closeBoth(1011, 'RPC upstream unavailable'))
      upstream.once('close', () => closeBoth(1011, 'RPC upstream closed'))
      client.on('message', (data, isBinary) => {
        if (isBinary || Buffer.byteLength(data as Buffer) > maxMessageBytes) return closeBoth(1009, 'RPC message too large')
        const text = data.toString()
        let payload: unknown
        try { payload = JSON.parse(text) as unknown } catch { return sendJson(client, rpcError(null, -32700, 'Parse error')) }
        const parsed = parseRpcPayload(payload, network)
        if (!Array.isArray(parsed)) return sendJson(client, parsed)
        if (parsed.some((entry) => !isSubscriptionMethod(entry.method))) {
          return sendJson(client, rpcError(parsed[0]?.id ?? null, -32601, 'Only RPC subscriptions are available over websocket'))
        }
        const quota = limiter.consume(identity(request, options.trustForwardedHeaders === true), parsed.length)
        if (quota && !quota.ok) return closeBoth(1008, 'RPC rate limit exceeded')
        forward(text)
      })
      client.once('close', () => closeBoth())
      client.once('error', () => closeBoth(1011, 'RPC websocket error'))
    })
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
    wss.close()
  }
}
