import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  evaluatePacketComparisonEvidence,
  parsePacketComparisonThresholds,
  type PacketComparisonThresholdsV1,
} from './packet-blind-evaluation-command'
import type { BlindPacketManifestV1, BlindPacketScoreV1 } from './packet-blind-evaluator'

const MAX_INPUT_BYTES = 128 * 1024 * 1024

function main(): void {
  const args = flags(process.argv.slice(2), ['--manifest', '--reviews', '--thresholds'])
  const manifest = readJson<BlindPacketManifestV1>(required(args, '--manifest'))
  const reviews = readJson<BlindPacketScoreV1[]>(required(args, '--reviews'))
  if (!Array.isArray(reviews)) throw new Error('reviews input must be a JSON array')
  const thresholdInput = readJson<Record<string, string | number>>(required(args, '--thresholds'))
  const thresholds = parsePacketComparisonThresholds(Object.fromEntries(
    Object.entries(thresholdInput).map(([key, value]) => [key, String(value)]),
  )) as PacketComparisonThresholdsV1
  const artifact = evaluatePacketComparisonEvidence({ manifest, reviews, thresholds })
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`)
  if (!artifact.passed) process.exitCode = 2
}

function readJson<T>(value: string): T {
  const path = resolve(value)
  if (statSync(path).size > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
function flags(argv: string[], allowed: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !allowed.includes(key) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    }
    if (result.has(key)) throw new Error(`Duplicate argument: ${key}`)
    result.set(key, value)
  }
  return result
}
function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

try { main() } catch (error) {
  process.stderr.write(`[feed-v3-evaluate-packet-comparison] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
}
