import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HermesService } from '../hermes'
import { createConfiguredInferenceGateway, type InferenceGateway } from '../inference-gateway'
import type {
  XDeskDecision,
  XDeskDecisionResponse,
  XDeskProvider,
  XDeskReviewInput,
} from './types'

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000

export interface GatewayXDeskProviderOptions {
  timeoutMs?: number
  service?: HermesService
  gateway?: Pick<InferenceGateway, 'generateStructured'>
}

function evidenceUrls(evidence: unknown[]): string[] {
  const urls = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) urls.add(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(evidence)
  return [...urls].slice(0, 5)
}

function promptInput(input: XDeskReviewInput): Record<string, unknown> {
  const bounded = (value: string | null, limit: number): string | null => (
    value && value.length > limit ? `${value.slice(0, limit)}…` : value
  )
  return {
    candidateId: input.candidateId,
    entity: { ...input.entity, summary: bounded(input.entity.summary, 500) },
    memory: {
      memoryType: input.memory.memoryType,
      title: bounded(input.memory.title, 300),
      summary: bounded(input.memory.summary, 1_000),
      body: bounded(input.memory.body, 2_000),
      eventAt: input.memory.eventAt,
      observedAt: input.memory.observedAt,
      confidence: input.memory.confidence,
      priorityClass: input.memory.priorityClass,
      mentions: input.memory.mentions.slice(0, 20),
      metrics: input.memory.metrics,
      sourceType: input.memory.provenance.sourceType,
      sourceRefId: input.memory.provenance.sourceRefId,
      evidenceUrls: evidenceUrls(input.memory.evidence),
    },
  }
}

export async function buildXDeskPrompt(
  inputs: XDeskReviewInput[],
  priorPosts: string[],
  maxRecommendations: number,
): Promise<string> {
  const stablePrompt = await readFile(join(__dirname, 'x-desk-prompt.md'), 'utf8')
  return [
    stablePrompt,
    '',
    '## Review Batch',
    JSON.stringify({
      maxRecommendations,
      priorRecommendedPosts: priorPosts,
      candidates: inputs.map(promptInput),
    }, null, 2),
  ].join('\n')
}

function decisionResponse(
  value: unknown,
  inputs: XDeskReviewInput[],
  maxRecommendations: number,
): { valid: true, value: XDeskDecisionResponse } | { valid: false, issues: string[] } {
  const issues: string[] = []
  if (!value || typeof value !== 'object' || !Array.isArray((value as { decisions?: unknown }).decisions)) {
    return { valid: false, issues: ['decisions must be an array'] }
  }

  const expected = new Set(inputs.map((input) => input.candidateId))
  const seen = new Set<string>()
  const raw = (value as { decisions: unknown[] }).decisions
  const decisions: XDeskDecision[] = []
  let recommendations = 0

  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`decisions[${index}] must be an object`)
      continue
    }
    const record = item as Record<string, unknown>
    const candidateId = typeof record.candidateId === 'string' ? record.candidateId : ''
    const action = record.action
    const postText = record.postText
    const rationale = typeof record.rationale === 'string' ? record.rationale.trim() : ''
    const confidence = record.confidence

    if (!expected.has(candidateId)) issues.push(`decisions[${index}].candidateId is unknown`)
    if (seen.has(candidateId)) issues.push(`candidate ${candidateId} was returned more than once`)
    seen.add(candidateId)
    if (action !== 'recommend' && action !== 'skip') issues.push(`decisions[${index}].action is invalid`)
    if (!rationale || rationale.length > 500) issues.push(`decisions[${index}].rationale must contain 1-500 characters`)
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      issues.push(`decisions[${index}].confidence must be between 0 and 1`)
    }
    if (action === 'recommend') {
      recommendations += 1
      if (typeof postText !== 'string' || postText.trim().length < 1 || [...postText.trim()].length > 280) {
        issues.push(`decisions[${index}].postText must contain 1-280 characters for a recommendation`)
      }
    } else if (postText !== null) {
      issues.push(`decisions[${index}].postText must be null for a skip`)
    }

    if ((action === 'recommend' || action === 'skip')
      && typeof confidence === 'number' && Number.isFinite(confidence)
      && rationale) {
      decisions.push({
        candidateId,
        action,
        postText: typeof postText === 'string' ? postText.trim() : null,
        rationale,
        confidence,
      })
    }
  }

  if (raw.length !== inputs.length) issues.push(`decisions must contain exactly ${inputs.length} items`)
  for (const id of expected) if (!seen.has(id)) issues.push(`candidate ${id} is missing`)
  if (recommendations > maxRecommendations) issues.push(`recommendations exceed the maximum of ${maxRecommendations}`)
  if (issues.length > 0) return { valid: false, issues }
  return { valid: true, value: { decisions } }
}

export class GatewayXDeskProvider implements XDeskProvider {
  private readonly gateway: Pick<InferenceGateway, 'generateStructured'>
  private readonly timeoutMs: number

  constructor(options: GatewayXDeskProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const service = options.service ?? new HermesService({
      command: process.env.X_DESK_HERMES_COMMAND ?? process.env.HERMES_COMMAND ?? 'hermes',
    })
    this.gateway = options.gateway ?? createConfiguredInferenceGateway({ serviceFactory: () => service }).gateway
  }

  async decide(inputs: XDeskReviewInput[], priorPosts: string[], maxRecommendations: number): Promise<XDeskDecision[]> {
    if (inputs.length === 0) return []
    const prompt = await buildXDeskPrompt(inputs, priorPosts, maxRecommendations)
    const result = await this.gateway.generateStructured<XDeskDecisionResponse>({
      workload: 'editor.draft',
      purpose: 'x-desk.review',
      prompt,
      promptVersion: 'x-desk.prompt.v1',
      policyVersion: 'x-desk.review-only.v1',
      budget: {
        maxProviderCalls: 2,
        maxRepairCalls: 1,
        maxInputTokens: 60_000,
        maxOutputTokens: 8_000,
        maxWallTimeMs: this.timeoutMs,
        maxToolCalls: 0,
      },
      validate: (value) => decisionResponse(value, inputs, maxRecommendations),
    })
    return result.value.decisions
  }
}

export const __xDeskProviderTesting = { decisionResponse, evidenceUrls }
