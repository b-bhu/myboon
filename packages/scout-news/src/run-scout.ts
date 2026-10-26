/**
 * Placeholder PM2 entry for the V4 scout stage (#444).
 *
 * The real runner lands with #473 as src/run.ts; the ecosystem entry is
 * repointed then, and that runner is wrapped by the same gate.
 */
import { runGatedScout } from '../../shared/src/v4-runtime/scout-gate.ts'

async function run(): Promise<void> {
  // Nothing to lazily import yet — the real runner arrives with #473.
  process.stdout.write(
    `${JSON.stringify({ level: 'info', stage: 'scout-news', msg: 'scout runner lands with #473' })}\n`,
  )
}

void runGatedScout({ run })