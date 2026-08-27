import { randomBytes } from 'node:crypto'
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
  PACKET_PAIR_SCHEMA_VERSION,
  prepareBlindPacketEvaluation,
  type ResearchPacketPairV1,
} from './packet-blind-evaluator'

const MAX_INPUT_BYTES = 128 * 1024 * 1024

function main(): void {
  const args = flags(process.argv.slice(2), ['--input', '--dataset-id', '--assignments-out', '--manifest-out'])
  const inputPath = resolve(required(args, '--input'))
  const assignmentsPath = absolute(required(args, '--assignments-out'), '--assignments-out')
  const manifestPath = absolute(required(args, '--manifest-out'), '--manifest-out')
  if (assignmentsPath === manifestPath) throw new Error('assignment and manifest outputs must differ')
  if (statSync(inputPath).size > MAX_INPUT_BYTES) throw new Error(`Packet-pair input exceeds ${MAX_INPUT_BYTES} bytes`)
  const pairs = parsePairs(readFileSync(inputPath, 'utf8'))
  const bundle = prepareBlindPacketEvaluation({
    datasetId: required(args, '--dataset-id'),
    blindingSeed: randomBytes(32).toString('hex'),
    pairs,
  })
  let assignmentsWritten = false
  try {
    writeFileSync(assignmentsPath, `${JSON.stringify(bundle.assignments, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    assignmentsWritten = true
    writeFileSync(manifestPath, `${JSON.stringify(bundle.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (assignmentsWritten) try { unlinkSync(assignmentsPath) } catch { /* best effort rollback */ }
    throw error
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'myboon.packet_comparison_preparation.v1',
    datasetId: bundle.manifest.datasetId,
    assignments: bundle.assignments.length,
    assignmentsPath,
    manifestPath,
  }, null, 2)}\n`)
}

function parsePairs(bytes: string): ResearchPacketPairV1[] {
  const trimmed = bytes.trim()
  if (!trimmed) throw new Error('Packet-pair input is empty')
  const parsed = trimmed.startsWith('[')
    ? JSON.parse(trimmed) as unknown
    : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown)
  if (!Array.isArray(parsed)) throw new Error('Packet-pair input must be an array or JSONL')
  for (const item of parsed) {
    if (!item || typeof item !== 'object'
      || (item as { schemaVersion?: unknown }).schemaVersion !== PACKET_PAIR_SCHEMA_VERSION) {
      throw new Error('Packet-pair input contains an invalid schema version')
    }
  }
  return parsed as ResearchPacketPairV1[]
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
function absolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return resolve(value)
}

try { main() } catch (error) {
  process.stderr.write(`[feed-v3-prepare-packet-comparison] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
}
