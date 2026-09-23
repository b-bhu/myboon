import { loadDotenvChain, positiveInteger } from '../pipeline-store/cli-env'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { createConfiguredClassificationRuntime } from './classification-configuration'

const DEFAULT_INTERVAL_MS = 2_000

async function main(): Promise<void> {
  loadDotenvChain()
  const intervalMs = positiveInteger(process.env.CLASSIFICATION_SHADOW_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  const runOnce = process.argv.includes('--once')
  const runtime = createConfiguredClassificationRuntime()
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)

  const drain = async () => {
    while (!controller.signal.aborted) {
      const claimed = runtime.store.claimShadow()
      if (!claimed) return
      try {
        await runtime.gateway.executeShadow(claimed.envelope)
        runtime.store.completeShadow(claimed.envelope.decisionId, claimed.leaseToken)
      } catch (error) {
        runtime.store.failShadow(
          claimed.envelope.decisionId,
          claimed.leaseToken,
          error instanceof Error ? error.message : String(error),
          null,
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
