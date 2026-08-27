import type { ResearchWorkItem, Signal } from '../signal-platform/contracts'
import { PlatformFailure } from '../signal-platform/failures'
import { parseHttpUrl } from '../news/safe-public-http'
import type { ApprovedRetrievalUrl } from './deterministic-retrieval'

export interface SearchConnectorResult {
  url: string
  title: string | null
  providerResultId: string
}

export interface RegisteredSearchConnector {
  readonly connectorId: string
  search(input: {
    query: string
    limit: number
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<SearchConnectorResult[]>
}

export interface StandardSearchPolicy {
  policyVersion: string
  connectorId: string
  maxQueries: number
  maxResultsPerQuery: number
  maxQueryChars: number
  timeoutMs: number
}

export interface StandardSearchPlan {
  policyVersion: string
  connectorId: string
  queryCount: number
  urls: ApprovedRetrievalUrl[]
}

/** Explicit registry prevents an inference model from selecting a search provider. */
export class SearchConnectorRegistry {
  private readonly connectors: ReadonlyMap<string, RegisteredSearchConnector>

  constructor(connectors: RegisteredSearchConnector[]) {
    const registered = new Map<string, RegisteredSearchConnector>()
    for (const connector of connectors) {
      const id = connector.connectorId.trim()
      if (!id) throw new Error('Search connector ID must not be empty')
      if (registered.has(id)) throw new Error(`Duplicate search connector: ${id}`)
      registered.set(id, connector)
    }
    this.connectors = registered
  }

  require(connectorId: string): RegisteredSearchConnector {
    const connector = this.connectors.get(connectorId)
    if (!connector) throw new PlatformFailure({
      category: 'retrieval_blocked',
      message: `Registered search connector ${connectorId} is unavailable`,
      retryable: false,
      incrementsAttempt: false,
    })
    return connector
  }
}

export class BoundedStandardSearch {
  constructor(
    private readonly registry: SearchConnectorRegistry,
    private readonly policy: StandardSearchPolicy,
  ) {
    positiveInteger(policy.maxQueries, 'maxQueries', 1, 3)
    positiveInteger(policy.maxResultsPerQuery, 'maxResultsPerQuery', 1, 10)
    positiveInteger(policy.maxQueryChars, 'maxQueryChars', 16, 500)
    positiveInteger(policy.timeoutMs, 'timeoutMs', 100, 30_000)
    if (!policy.policyVersion.trim() || !policy.connectorId.trim()) throw new Error('Search policy and connector IDs are required')
  }

  async discover(input: {
    signal: Signal
    work: ResearchWorkItem
    queries: string[]
    signalAbort?: AbortSignal
  }): Promise<StandardSearchPlan> {
    if (input.work.researchDepth !== 'standard') {
      throw new PlatformFailure({
        category: 'retrieval_blocked', message: 'Search discovery is permitted only for standard research',
        retryable: false, incrementsAttempt: false,
      })
    }
    if (input.work.signalId !== input.signal.signalId || input.work.sourceType !== input.signal.sourceType) {
      throw new PlatformFailure({
        category: 'schema_version_mismatch', message: 'Search work does not match its canonical Signal',
        retryable: false, incrementsAttempt: false,
      })
    }
    // maxExternalSources excludes the canonical source URL. The source is
    // always planned separately and must not consume corroboration capacity.
    const remaining = input.work.retrievalPlan.maxExternalSources
    if (remaining === 0 || input.queries.length === 0) {
      return { policyVersion: this.policy.policyVersion, connectorId: this.policy.connectorId, queryCount: 0, urls: [] }
    }

    const connector = this.registry.require(this.policy.connectorId)
    const queries = input.queries.slice(0, this.policy.maxQueries).map((query) => boundedQuery(query, this.policy.maxQueryChars))
    const discovered: ApprovedRetrievalUrl[] = []
    const seen = new Set<string>()
    for (const query of queries) {
      if (discovered.length >= remaining) break
      const results = await connector.search({
        query,
        limit: Math.min(this.policy.maxResultsPerQuery, remaining - discovered.length),
        timeoutMs: this.policy.timeoutMs,
        signal: input.signalAbort,
      })
      if (results.length > this.policy.maxResultsPerQuery) {
        throw new PlatformFailure({
          category: 'budget_exceeded', message: 'Search connector exceeded its result budget',
          retryable: false, incrementsAttempt: false,
        })
      }
      for (const result of results) {
        if (discovered.length >= remaining) break
        const url = parseHttpUrl(result.url)
        if (!isAllowedHost(url.hostname, input.work.retrievalPlan.allowedDomains)) continue
        const normalized = url.toString()
        if (seen.has(normalized)) continue
        seen.add(normalized)
        discovered.push({
          url: normalized,
          authority: 'search_connector',
          authorityId: `${connector.connectorId}:${result.providerResultId}`,
        })
      }
    }
    return {
      policyVersion: this.policy.policyVersion,
      connectorId: this.policy.connectorId,
      queryCount: queries.length,
      urls: discovered,
    }
  }
}

function boundedQuery(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) throw new Error('Search query must not be empty')
  if (normalized.length > maxChars) throw new PlatformFailure({
    category: 'budget_exceeded', message: `Search query exceeds ${maxChars} characters`,
    retryable: false, incrementsAttempt: false,
  })
  return normalized
}

function isAllowedHost(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
    return host === allowed || host.endsWith(`.${allowed}`)
  })
}

function positiveInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
