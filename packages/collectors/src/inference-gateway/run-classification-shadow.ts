import { loadDotenvChain, positiveInteger } from '../pipeline-store/cli-env'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { createConfiguredClassificationRuntime } from './classification-configuration'
import { InferenceGatewayError } from './errors'

const DEFAULT_INTERVAL_MS = 2_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_BACKOFF_MS = 5_000
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000
const SHADOW_PRUNE_INTERVAL_MS = 60 * 60_000

async function main(): Promise<void> {
  loadDotenvChain()
  const intervalMs = positiveInteger(process.env.CLASSIFICATION_SHADOW_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  const maxAttempts = positiveInteger(process.env.CLASSIFICATION_SHADOW_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS)
  const baseBackoffMs = positiveInteger(process.env.CLASSIFICATION_SHADOW_BASE_BACKOFF_MS, DEFAULT_BASE_BACKOFF_MS)
  const maxBackoffMs = positiveInteger(process.env.CLASSIFICATION_SHADOW_MAX_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS)
  const runOnce = process.argv.includes('--once')
  const runtime = createConfiguredClassificationRuntime()
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let lastPrunedAtMs = 0

  const drain = async () => {
    const nowMs = Date.now()
    if (nowMs - lastPrunedAtMs >= SHADOW_PRUNE_INTERVAL_MS) {
      runtime.store.pruneShadowOutbox()
      lastPrunedAtMs = nowMs
    }
    while (!controller.signal.aborted) {
      const claimed = runtime.store.claimShadow()
      if (!claimed) return
      try {
        await runtime.gateway.executeShadow(claimed.envelope, claimed.attempt)
        runtime.store.completeShadow(claimed.envelope.decisionId, claimed.leaseToken)
      } catch (error) {
        const retryAtMs = classificationShadowRetryAt({
          error,
          attempt: claimed.attempt,
          nowMs: Date.now(),
          maxAttempts,
          baseBackoffMs,
          maxBackoffMs,
        })
        runtime.store.failShadow(
          claimed.envelope.decisionId,
          claimed.leaseToken,
          error instanceof Error ? error.message : String(error),
          retryAtMs,
        )
      }
    }
  }

  try {
    await drain()
    if (runOnce || controller.signal.aborted) return
    const runner = startIntervalRunner({ label: 'classification-shadow', intervalMs, run: drain })
    await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
    runner.stop()
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    runtime.close()
  }
}

export function classificationShadowRetryAt(input: {
  error: unknown
  attempt: number
  nowMs: number
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
}): number | null {
  if (!(input.error instanceof InferenceGatewayError) || !input.error.retryable
    || input.attempt >= input.maxAttempts) return null
  const exponential = Math.min(input.maxBackoffMs, input.baseBackoffMs * (2 ** Math.max(0, input.attempt - 1)))
  return input.nowMs + Math.max(exponential, input.error.retryAfterMs ?? 0)
}

if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
