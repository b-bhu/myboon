import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { loadDotenvChain } from '../../pipeline-store/cli-env'
import { HermesService } from '../../hermes'
import { HermesDecisionAdapter, JevSystemOneAdapter } from '../../inference-gateway/classification-adapters'
import { researchNoveltyDefinition, researchFollowupValueDefinition, type ResearchNoveltyDecision,
  type ResearchFollowupValueDecision, type ResearchNoveltyState } from '../../inference-gateway/classification-definitions'
import type { ClassificationDefinition, JevClassificationAdapter, HermesClassificationAdapter,
  JevClassificationResponse, HermesClassificationResponse } from '../../inference-gateway/classification-types'
import { canonicalJson } from '../../signal-platform/canonical-json'
import type { ResearchEvaluationFixture } from './fixtures'
import { RESEARCH_EVALUATION_FIXTURES } from './fixtures'

export interface LiveResearchCase extends Omit<ResearchEvaluationFixture, 'label'> {
  label: ResearchEvaluationFixture['label'] | null
  origin?: { kind: 'synthetic' | 'actual_source' | 'actual_source_transform'; sourceRef?: string; capturedAt?: string; reviewer?: string }
}
export interface LiveResearchEvaluationOptions {
  fixtures: readonly LiveResearchCase[]
  directory: string
  runId: string
  providers: readonly ('jev' | 'hermes')[]
  maxProviderCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  deadlineMs: number
  /** Declared native CLI call allowance; a verified title-disabled one-turn profile can use one. */
  hermesProviderCallCeiling?: number
  env?: Readonly<Record<string, string | undefined>>
  adapters?: { jev: JevClassificationAdapter, hermes: HermesClassificationAdapter }
  onProgress?: (status: { fixtureId: string, provider: string, state: string }) => void
}
interface LiveDispatchRecord {
  key: string; runId: string; fixtureId: string; provider: 'jev' | 'hermes'; requestDigest: string
  state: 'dispatch_intent' | 'saved_response' | 'execution_outcome_unknown'
  inputCeiling: number; outputCeiling: number; dispatchedAt: string
  providerCallCeiling?: number
  usage: { inputTokens: number | null; outputTokens: number | null; providerCalls: number | null; costUsdMicros: number | null; durationMs: number | null;
    auxiliaryProviderCalls?: number | null; totalTokens?: number | null } | null
  usageKind?: 'provider_measured' | 'adapter_estimated'
  actualProvider?: string; actualModel?: string
  decision?: ResearchEvaluationFixture['label'] | null; accepted?: boolean; acceptanceReason?: string
  expectedLabel?: ResearchEvaluationFixture['label'] | null; agreesWithLabel?: boolean | null
  eligibleKnownSkip?: boolean; mayBuyFollowup?: boolean; failureCategory?: string
  guardedDisposition?: 'unknown_hold' | 'proceed_conservatively' | 'eligible_covered_observation' | 'retain_baseline' | 'value_positive_admission_unproved'
  response?: JevClassificationResponse | HermesClassificationResponse
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const savePrivate = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(path, 0o600) }
const routes = new Set(['openai-codex/gpt-5.6-luna', 'ollama-cloud/glm-5.3-flash', 'ollama-cloud/deepseek-v4-flash', 'ollama-cloud/deepseek-v4.1-flash'])
const evaluationOnlyRoutes = new Set(['openrouter/stealth/space-bunny-alpha'])
const percentile = (values: readonly number[], fraction: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
function reportedHermesUsage(path: string, durationMs: number): NonNullable<LiveDispatchRecord['usage']> | null {
  if (!existsSync(path)) return null
  const usage = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const auxiliary = usage.auxiliary && typeof usage.auxiliary === 'object' ? usage.auxiliary as Record<string, unknown> : {}
  const total = usage.total_including_auxiliary && typeof usage.total_including_auxiliary === 'object'
    ? usage.total_including_auxiliary as Record<string, unknown> : {}
  const sum = (primary: unknown, extra: unknown): number | null => count(primary) === null || count(extra) === null ? null : count(primary)! + count(extra)!
  if (count(total.api_calls) === null) return null
  return { inputTokens: sum(usage.input_tokens, auxiliary.input_tokens), outputTokens: sum(usage.output_tokens, auxiliary.output_tokens),
    providerCalls: count(total.api_calls), auxiliaryProviderCalls: count(auxiliary.api_calls),
    totalTokens: count(total.total_tokens), durationMs, costUsdMicros: null }
}

/** Explicit live evaluation only: private checkpoints precede one production transport attempt. */
export async function runLiveResearchEvaluation(options: LiveResearchEvaluationOptions) {
  if (!isAbsolute(options.directory) || !options.runId.trim() || options.fixtures.length === 0
    || !options.providers.length || new Set(options.providers).size !== options.providers.length
    || new Set(options.fixtures.map((fixture) => fixture.id)).size !== options.fixtures.length
    || ![options.maxProviderCalls, options.maxInputTokens, options.maxOutputTokens, options.deadlineMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Live evaluation requires explicit unique cases/providers, an absolute private output path and positive reproducible limits')
  }
  const env = options.env ?? process.env
  const hermesTarget = { provider: env.INFERENCE_GATEWAY_PRIMARY_PROVIDER?.trim() || 'ollama-cloud',
    model: env.INFERENCE_GATEWAY_PRIMARY_MODEL?.trim() || 'glm-5.3-flash' }
  const hermesProfile = env.INFERENCE_GATEWAY_HERMES_PROFILE?.trim() || undefined
  const hermesProviderCallCeiling = options.hermesProviderCallCeiling ?? 2
  if (!Number.isSafeInteger(hermesProviderCallCeiling) || hermesProviderCallCeiling < 1) throw new Error('Hermes inner provider call ceiling must be a positive explicit integer')
  const route = `${hermesTarget.provider}/${hermesTarget.model}`
  if (!routes.has(route) && !evaluationOnlyRoutes.has(route)) throw new Error('Live evaluation Hermes route is not approved')
  if (env.JEV_API_ENDPOINT && env.JEV_API_ENDPOINT !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Live evaluation Jev endpoint is not approved')
  if (!options.adapters && options.providers.includes('jev') && !env.JEV_API_TOKEN?.trim()) throw new Error('Live evaluation requires configured Jev credentials')
  // Validate the complete admission before any case can spend provider capacity.
  for (const fixture of options.fixtures) {
    const definition = fixture.workload === 'novelty' ? researchNoveltyDefinition(hermesTarget) : researchFollowupValueDefinition(hermesTarget)
    const validated = definition.validateState(fixture.state)
    if (!validated.valid) throw new Error(`Live case ${fixture.id} violates approved state contract: ${validated.issues.join('; ')}`)
    if (Buffer.byteLength(canonicalJson(validated.value)) > definition.budget.maxStateBytes) throw new Error('Live case exceeds approved state byte ceiling')
  }
  mkdirSync(options.directory, { recursive: true, mode: 0o700 }); chmodSync(options.directory, 0o700)
  const receipt = { runId: options.runId, providers: options.providers, maxProviderCalls: options.maxProviderCalls,
    maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens, deadlineMs: options.deadlineMs,
    casesDigest: hash(options.fixtures), hermesTarget, jevModel: 'jev-1.13.0', version: 'research.live-evaluation.v1',
    ...(hermesProfile ? { hermesProfile } : {}),
    ...(options.hermesProviderCallCeiling === undefined ? {} : { hermesProviderCallCeiling }),
    ...(evaluationOnlyRoutes.has(route) ? { evaluationOnlyHermesRoute: true } : {}) }
  const receiptPath = join(options.directory, 'run-receipt.json')
  if (existsSync(receiptPath) && canonicalJson(JSON.parse(readFileSync(receiptPath, 'utf8'))) !== canonicalJson(receipt)) {
    throw new Error('Run receipt changed; existing dispatch identities cannot receive different policy, cases or limits')
  }
  if (!existsSync(receiptPath)) savePrivate(receiptPath, receipt)
  savePrivate(join(options.directory, 'reviewed-cases.json'), options.fixtures)
  let currentKey = ''
  const service = new HermesService()
  const adapters = options.adapters ?? {
    jev: new JevSystemOneAdapter({ apiToken: env.JEV_API_TOKEN ?? 'unused-jev-route', fetchImpl: async (input, init) => {
      const response = await fetch(input, init)
      savePrivate(join(options.directory, `${currentKey}.native.json`), { status: response.status, body: await response.clone().text(), capturedAt: new Date().toISOString() })
      return response
    } }),
    hermes: new HermesDecisionAdapter({ profile: hermesProfile,
      service: { oneshot: async (request) => {
        const usageFilePath = join(options.directory, `${currentKey}.cli-usage.json`)
        savePrivate(usageFilePath, {})
        try {
          const response = await service.oneshot({ ...request, toolsets: 'none', ignoreRules: true, usageFilePath })
          chmodSync(usageFilePath, 0o600)
          savePrivate(join(options.directory, `${currentKey}.native.json`), { stdout: response.stdout, stderr: response.stderr, capturedAt: new Date().toISOString(),
            tools: 'none', rulesIgnored: true })
          return response
        } catch (error) {
          const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown }
          chmodSync(usageFilePath, 0o600)
          savePrivate(join(options.directory, `${currentKey}.native.json`), { stdout: failure.stdout ?? null,
            stderr: failure.stderr ?? null, error: failure.message ?? null, code: failure.code ?? null,
            capturedAt: new Date().toISOString(), tools: 'none', rulesIgnored: true })
          throw error
        }
      } } }),
  }
  const records: LiveDispatchRecord[] = []
  for (const fixture of options.fixtures) {
    const definition: ClassificationDefinition<ResearchNoveltyState, ResearchNoveltyDecision | ResearchFollowupValueDecision> =
      fixture.workload === 'novelty' ? researchNoveltyDefinition(hermesTarget) : researchFollowupValueDefinition(hermesTarget)
    const validated = definition.validateState(fixture.state)
    if (!validated.valid) throw new Error(`Live case ${fixture.id} violates approved state contract: ${validated.issues.join('; ')}`)
    if (Buffer.byteLength(canonicalJson(validated.value)) > definition.budget.maxStateBytes) throw new Error('Live case exceeds approved state byte ceiling')
    for (const provider of options.providers) {
      const request = provider === 'jev'
        ? { target: definition.jevTarget, state: validated.value, questions: definition.questions(validated.value) }
        : { target: hermesTarget, prompt: definition.renderHermes(validated.value), ...(hermesProfile ? { profile: hermesProfile } : {}) }
      const requestDigest = hash({ workload: definition.workload, version: definition.decisionVersion, request })
      const key = hash({ runId: options.runId, fixtureId: fixture.id, provider, requestDigest })
      const path = join(options.directory, `${key}.dispatch.json`)
      currentKey = key
      if (existsSync(path)) {
        const saved = JSON.parse(readFileSync(path, 'utf8')) as LiveDispatchRecord
        if (saved.state === 'dispatch_intent') { saved.state = 'execution_outcome_unknown'; savePrivate(path, saved) }
        records.push(saved); options.onProgress?.({ fixtureId: fixture.id, provider, state: `retained_${saved.state}` }); continue
      }
      const existing = readdirSync(options.directory).filter((name) => name.endsWith('.dispatch.json'))
        .map((name) => JSON.parse(readFileSync(join(options.directory, name), 'utf8')) as LiveDispatchRecord)
      const inputExposure = existing.reduce((sum, row) => sum + (row.usageKind === 'provider_measured' ? row.usage?.inputTokens ?? row.inputCeiling : row.inputCeiling), 0)
      const outputExposure = existing.reduce((sum, row) => sum + (row.usageKind === 'provider_measured' ? row.usage?.outputTokens ?? row.outputCeiling : row.outputCeiling), 0)
      const callCeiling = provider === 'hermes' ? hermesProviderCallCeiling : 1
      const providerCallExposure = existing.reduce((sum, row) => sum + (row.usage?.providerCalls ?? row.providerCallCeiling ?? (row.provider === 'hermes' ? 2 : 1)), 0)
      if (providerCallExposure + callCeiling > options.maxProviderCalls || inputExposure + definition.budget.maxInputTokens > options.maxInputTokens
        || outputExposure + definition.budget.maxOutputTokens > options.maxOutputTokens) throw new Error('Live evaluation aggregate call/token limits exhausted; no fresh allowance is invented')
      const row: LiveDispatchRecord = { key, runId: options.runId, fixtureId: fixture.id, provider, requestDigest, state: 'dispatch_intent',
        inputCeiling: definition.budget.maxInputTokens, outputCeiling: definition.budget.maxOutputTokens, dispatchedAt: new Date().toISOString(), usage: null,
        providerCallCeiling: callCeiling,
        expectedLabel: fixture.label }
      // The intent is durable before passing credentials or untrusted material to transport.
      writeFileSync(path, JSON.stringify(row), { flag: 'wx', mode: 0o600 })
      savePrivate(join(options.directory, `${key}.request.json`), { requestDigest, workload: definition.workload, decisionVersion: definition.decisionVersion, request })
      const startedAt = Date.now()
      try {
        let response: JevClassificationResponse | HermesClassificationResponse
        if (provider === 'jev') {
          response = await adapters.jev.classify({ workload: definition.workload, decisionVersion: definition.decisionVersion,
            state: validated.value, questions: definition.questions(validated.value), target: definition.jevTarget,
            deadlineMs: Math.min(options.deadlineMs, definition.budget.deadlineMs), signal: AbortSignal.timeout(Math.min(options.deadlineMs, definition.budget.deadlineMs)) })
        } else {
          response = await adapters.hermes.classify({ workload: definition.workload, decisionVersion: definition.decisionVersion,
            prompt: definition.renderHermes(validated.value), target: hermesTarget,
            deadlineMs: Math.min(options.deadlineMs, definition.budget.deadlineMs), signal: AbortSignal.timeout(Math.min(options.deadlineMs, definition.budget.deadlineMs)) })
        }
        const expectedTarget = provider === 'jev' ? definition.jevTarget : hermesTarget
        if (response.actualProvider !== expectedTarget.provider || response.actualModel !== expectedTarget.model
          || count(response.usage.inputTokens) === null || count(response.usage.outputTokens) === null
          || !Number.isFinite(response.durationMs) || response.durationMs < 0
          || (response.usage.costUsdMicros !== undefined && count(response.usage.costUsdMicros) === null)) {
          throw new Error('Native adapter response has a mismatched route or invalid measured usage')
        }
        row.response = response; row.actualProvider = response.actualProvider; row.actualModel = response.actualModel
        row.usageKind = provider === 'jev' ? 'provider_measured' : 'adapter_estimated'
        row.usage = { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
          providerCalls: provider === 'jev' ? 1 : null, costUsdMicros: response.usage.costUsdMicros ?? null, durationMs: response.durationMs }
        const usagePath = join(options.directory, `${key}.cli-usage.json`)
        if (provider === 'hermes' && existsSync(usagePath)) {
          const usage = JSON.parse(readFileSync(usagePath, 'utf8')) as Record<string, unknown>
          if (usage.provider !== undefined && usage.provider !== null && usage.provider !== hermesTarget.provider
            || usage.model !== undefined && usage.model !== null && usage.model !== hermesTarget.model) {
            throw new Error('Native CLI resolved a different provider/model from its approved request')
          }
          const reported = reportedHermesUsage(usagePath, response.durationMs)
          if (reported) {
            row.usageKind = 'provider_measured'
            row.usage = reported
          }
        }
        const decoded = 'answers' in response ? definition.decodeJev(response.answers, validated.value) : definition.validateHermes(response.value, validated.value)
        const accepted = decoded.valid && ('answers' in response ? definition.acceptJev(response.answers, decoded.value, validated.value).accepted : true)
        row.decision = decoded.valid ? ('verdict' in decoded.value ? decoded.value.verdict : decoded.value.direction) : null
        row.accepted = accepted
        row.acceptanceReason = decoded.valid ? ('answers' in response ? definition.acceptJev(response.answers, decoded.value, validated.value).reason : 'Valid Hermes typed decision') : 'Invalid typed decision'
        row.agreesWithLabel = fixture.label === null ? null : row.decision === fixture.label
        row.eligibleKnownSkip = accepted && row.decision === 'already_known' && fixture.coverage.completeSource && fixture.coverage.completeLookup
          && fixture.coverage.itemRefs.length > 0 && fixture.coverage.failures.length === 0
          && fixture.state.context.entities.length > 0 && fixture.state.context.recentMemories.length > 0
        row.mayBuyFollowup = accepted && row.decision === 'worthwhile'
        row.guardedDisposition = fixture.workload === 'novelty'
          ? row.eligibleKnownSkip ? 'eligible_covered_observation' : 'proceed_conservatively'
          : row.mayBuyFollowup ? 'value_positive_admission_unproved' : 'retain_baseline'
        row.state = 'saved_response'
        if (row.usage?.providerCalls != null && row.usage.providerCalls > callCeiling) {
          row.failureCategory = 'native_provider_calls_exceeded_declared_allowance'
          row.guardedDisposition = 'unknown_hold'
          row.accepted = false; row.eligibleKnownSkip = false; row.mayBuyFollowup = false
        }
      } catch (error) {
        row.state = 'execution_outcome_unknown'
        row.guardedDisposition = 'unknown_hold'
        row.failureCategory = typeof error === 'object' && error !== null && 'category' in error ? String(error.category) : 'transport_or_storage_unknown'
        row.usage = { providerCalls: null, inputTokens: null, outputTokens: null, costUsdMicros: null, durationMs: Date.now() - startedAt }
        if (provider === 'hermes') {
          try {
            const reported = reportedHermesUsage(join(options.directory, `${key}.cli-usage.json`), Date.now() - startedAt)
            if (reported) { row.usage = reported; row.usageKind = 'provider_measured' }
          } catch { /* Invalid/missing provider proof leaves the dispatch outcome and usage unknown. */ }
        }
      }
      savePrivate(path, row); records.push(row); options.onProgress?.({ fixtureId: fixture.id, provider, state: row.state })
    }
  }
  const summary = { runId: options.runId, cases: options.fixtures.length, dispatches: records.length, providers: options.providers,
    byProvider: Object.fromEntries(options.providers.map((provider) => {
      const rows = records.filter((row) => row.provider === provider), labeled = rows.filter((row) => row.expectedLabel !== null)
      return [provider, { dispatches: rows.length, savedResponses: rows.filter((row) => row.state === 'saved_response').length,
        unknownOutcomes: rows.filter((row) => row.state === 'execution_outcome_unknown').length,
        labeledCount: labeled.length, agreements: labeled.filter((row) => row.agreesWithLabel).length,
        acceptedCount: rows.filter((row) => row.accepted).length,
        rawFalseKnown: labeled.filter((row) => row.decision === 'already_known' && row.expectedLabel !== 'already_known').length,
        guardedFalseKnown: labeled.filter((row) => row.eligibleKnownSkip && row.expectedLabel !== 'already_known').length,
        knownSkipCount: rows.filter((row) => row.eligibleKnownSkip).length, worthwhileCount: rows.filter((row) => row.mayBuyFollowup).length,
        paidFollowupInvestigations: 0,
        measuredCostUsdMicros: rows.some((row) => row.usage?.costUsdMicros !== null && row.usage?.costUsdMicros !== undefined)
          ? rows.reduce((sum, row) => sum + (row.usage?.costUsdMicros ?? 0), 0) : null,
        unknownCostCount: rows.filter((row) => row.usage?.costUsdMicros === null || !row.usage).length,
        inputTokens: rows.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + (row.usage?.outputTokens ?? 0), 0),
        unknownInputTokenCount: rows.filter((row) => row.usage?.inputTokens === null || !row.usage).length,
        unknownOutputTokenCount: rows.filter((row) => row.usage?.outputTokens === null || !row.usage).length,
        unknownProviderCallCount: rows.filter((row) => row.usage?.providerCalls === null || !row.usage).length,
        reportedProviderCalls: rows.reduce((sum, row) => sum + (row.usage?.providerCalls ?? 0), 0),
        reportedAuxiliaryProviderCalls: rows.reduce((sum, row) => sum + (row.usage?.auxiliaryProviderCalls ?? 0), 0),
        latencyP50Ms: percentile(rows.flatMap((row) => row.usage?.durationMs == null ? [] : [row.usage.durationMs]), 0.50),
        latencyP95Ms: percentile(rows.flatMap((row) => row.usage?.durationMs == null ? [] : [row.usage.durationMs]), 0.95),
        tokenUsageKind: rows.every((row) => row.usageKind === 'provider_measured') ? 'provider_measured' : 'estimated_or_unknown_present',
      }]
    })), limitations: ['Hand-reviewed case labels concern supplied bounded material; model predictions never grade themselves.',
      'A positive follow-up value prediction alone has no executable admission; this runner dispatches no synthesis or investigation.',
      'Hermes usage-file measurements include reported auxiliary calls when present; absent usage leaves adapter estimates and unknown inner call counts explicit.',
      'Unknown monetary cost remains null, not zero. Classification-only comparison does not establish end-to-end savings or production significance.'] }
  savePrivate(join(options.directory, 'summary.json'), summary)
  return summary
}

if (require.main === module) {
  loadDotenvChain()
  const args = process.argv.slice(2), options: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || options[args[i].slice(2)]) throw new Error('Every live evaluation argument requires one explicit value')
    options[args[i].slice(2)] = args[i + 1]
  }
  const allowed = new Set(['cases', 'output', 'run-id', 'providers', 'max-provider-calls', 'max-input-tokens', 'max-output-tokens', 'deadline-ms', 'hermes-provider-call-ceiling'])
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error('Unknown live evaluation argument')
  const providers = (options.providers ?? '').split(',')
  if (providers.some((value) => value !== 'jev' && value !== 'hermes')) throw new Error('--providers must explicitly name jev and/or hermes')
  const fixtures = options.cases === 'synthetic' ? RESEARCH_EVALUATION_FIXTURES.map((fixture) => ({ ...fixture, origin: { kind: 'synthetic' as const } }))
    : JSON.parse(readFileSync(options.cases, 'utf8')) as LiveResearchCase[]
  void runLiveResearchEvaluation({ fixtures, directory: options.output, runId: options['run-id'], providers: providers as Array<'jev' | 'hermes'>,
    maxProviderCalls: Number(options['max-provider-calls']), maxInputTokens: Number(options['max-input-tokens']), maxOutputTokens: Number(options['max-output-tokens']),
    ...(options['hermes-provider-call-ceiling'] === undefined ? {} : { hermesProviderCallCeiling: Number(options['hermes-provider-call-ceiling']) }),
    deadlineMs: Number(options['deadline-ms']), onProgress: (value) => console.log(JSON.stringify(value)),
  }).then((summary) => console.log(JSON.stringify(summary))).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Live evaluation failed'); process.exitCode = 1
  })
}
