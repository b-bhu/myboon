import {
  BoundedStandardSearch,
  SearchConnectorRegistry,
  type RegisteredSearchConnector,
  type StandardSearchPolicy,
} from './search-connector'

export const STANDARD_SEARCH_ENV = Object.freeze({
  connector: 'FEED_V3_STANDARD_SEARCH_CONNECTOR',
  policyVersion: 'FEED_V3_STANDARD_SEARCH_POLICY_VERSION',
  maxQueries: 'FEED_V3_STANDARD_SEARCH_MAX_QUERIES',
  maxResultsPerQuery: 'FEED_V3_STANDARD_SEARCH_MAX_RESULTS_PER_QUERY',
  maxQueryChars: 'FEED_V3_STANDARD_SEARCH_MAX_QUERY_CHARS',
  timeoutMs: 'FEED_V3_STANDARD_SEARCH_TIMEOUT_MS',
})

export type RegisteredSearchConnectorFactory = () => RegisteredSearchConnector
export type RegisteredSearchConnectorFactories = Readonly<Record<string, RegisteredSearchConnectorFactory>>

export type StandardSearchConfiguration =
  | { enabled: false }
  | { enabled: true, policy: StandardSearchPolicy }

export interface StandardSearchStatusSnapshot {
  schemaVersion: 'myboon.standard_search_status.v1'
  enabled: boolean
  connectorId: string | null
  policyVersion: string | null
}

export function loadStandardSearchConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StandardSearchConfiguration {
  const connectorId = env[STANDARD_SEARCH_ENV.connector]
  if (connectorId === undefined) return Object.freeze({ enabled: false })
  const safeConnector = safeValue(connectorId, 'standard search connector')
  return Object.freeze({
    enabled: true,
    policy: Object.freeze({
      connectorId: safeConnector,
      policyVersion: safeValue(env[STANDARD_SEARCH_ENV.policyVersion] ?? '', 'standard search policy version'),
      maxQueries: integer(env[STANDARD_SEARCH_ENV.maxQueries], 1, 3, 2, 'standard search max queries'),
      maxResultsPerQuery: integer(env[STANDARD_SEARCH_ENV.maxResultsPerQuery], 1, 10, 5, 'standard search max results'),
      maxQueryChars: integer(env[STANDARD_SEARCH_ENV.maxQueryChars], 16, 500, 200, 'standard search max query chars'),
      timeoutMs: integer(env[STANDARD_SEARCH_ENV.timeoutMs], 100, 30_000, 5_000, 'standard search timeout'),
    }),
  })
}

/** A configured ID is usable only when code explicitly registered its factory. */
export function createConfiguredStandardSearch(input: {
  configuration: StandardSearchConfiguration
  factories?: RegisteredSearchConnectorFactories
}): BoundedStandardSearch | undefined {
  if (!input.configuration.enabled) return undefined
  const factory = input.factories?.[input.configuration.policy.connectorId]
  if (factory === undefined) {
    throw new Error(`Configured standard search connector ${input.configuration.policy.connectorId} is not registered`)
  }
  const connector = factory()
  if (connector.connectorId !== input.configuration.policy.connectorId) {
    throw new Error('Registered standard search connector factory returned a mismatched connector ID')
  }
  return new BoundedStandardSearch(new SearchConnectorRegistry([connector]), input.configuration.policy)
}

export function standardSearchStatus(configuration: StandardSearchConfiguration): StandardSearchStatusSnapshot {
  return Object.freeze({
    schemaVersion: 'myboon.standard_search_status.v1' as const,
    enabled: configuration.enabled,
    connectorId: configuration.enabled ? configuration.policy.connectorId : null,
    policyVersion: configuration.enabled ? configuration.policy.policyVersion : null,
  })
}

function safeValue(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) throw new Error(`${field} is missing or unsafe`)
  return value
}

function integer(raw: string | undefined, min: number, max: number, fallback: number, field: string): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be between ${min} and ${max}`)
  return value
}
