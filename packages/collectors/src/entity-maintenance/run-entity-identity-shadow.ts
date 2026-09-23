import { loadDotenvChain } from '../pipeline-store/cli-env'
import { resolve } from 'node:path'
import {
  CLASSIFICATION_ENV,
  createConfiguredClassificationRuntime,
  ENTITY_CATALOG_IDENTITY_VERSION,
  ENTITY_CATALOG_IDENTITY_WORKLOAD,
  type EntityCatalogIdentityDecision,
} from '../inference-gateway'
import { entityIdentityShadowFixtures } from './entity-identity-shadow'

async function main(): Promise<void> {
  loadDotenvChain()
  const env = {
    ...process.env,
    [CLASSIFICATION_ENV.lifecycleJson]: JSON.stringify({ [ENTITY_CATALOG_IDENTITY_WORKLOAD]: 'shadow' }),
    [CLASSIFICATION_ENV.sqlitePath]: resolve(
      process.env.ENTITY_IDENTITY_SHADOW_SQLITE_PATH?.trim() || '.data/entity-identity-shadow.sqlite',
    ),
  }
  const runtime = createConfiguredClassificationRuntime({ env })
  try {
    const fixtures = selectedFixtures(process.env.ENTITY_IDENTITY_SHADOW_CASES)
    const authoritative = [] as Array<{
      caseId: string; expected: string; decisionId: string; decision: EntityCatalogIdentityDecision
    }>
    for (const fixture of fixtures) {
      const result = await runtime.gateway.classify<EntityCatalogIdentityDecision>({
        workload: ENTITY_CATALOG_IDENTITY_WORKLOAD,
        decisionVersion: ENTITY_CATALOG_IDENTITY_VERSION,
        state: { candidate: fixture.candidate },
        trace: { stableDecisionKey: fixture.caseId, correlationIds: { pairKey: fixture.candidate.pairKey } },
      })
      authoritative.push({ caseId: fixture.caseId, expected: fixture.expectedDecision, decisionId: result.decisionId, decision: result.value })
    }
    for (;;) {
      const claimed = runtime.store.claimShadow()
      if (!claimed) break
      try {
        await runtime.gateway.executeShadow(claimed.envelope)
        runtime.store.completeShadow(claimed.envelope.decisionId, claimed.leaseToken)
      } catch (error) {
        runtime.store.failShadow(claimed.envelope.decisionId, claimed.leaseToken, error instanceof Error ? error.message : String(error), null)
      }
    }
    const cases = authoritative.map((item) => {
      const shadow = runtime.store.getAttempt(item.decisionId, 'shadow')
      const shadowDecision = shadow?.decision as EntityCatalogIdentityDecision | null
      return {
        caseId: item.caseId, expected: item.expected,
        hermes: item.decision,
        jev: shadowDecision,
        providersAgree: shadowDecision?.decision === item.decision.decision
          && shadowDecision.pollutedEntityId === item.decision.pollutedEntityId
          && shadowDecision.pollutedAlias === item.decision.pollutedAlias,
        hermesMatchesExpected: item.decision.decision === item.expected,
        jevMatchesExpected: shadowDecision?.decision === item.expected,
        shadowFailure: shadow?.failureCategory ?? null,
      }
    })
    console.log(JSON.stringify({
      schemaVersion: 'myboon.entity_identity_shadow.v2',
      readOnly: true,
      architecture: 'shared-classification-gateway',
      summary: {
        caseCount: cases.length,
        providerAgreementCount: cases.filter((item) => item.providersAgree).length,
        hermesExpectedCount: cases.filter((item) => item.hermesMatchesExpected).length,
        jevExpectedCount: cases.filter((item) => item.jevMatchesExpected).length,
      },
      cases,
    }, null, 2))
  } finally { runtime.close() }
}

function selectedFixtures(value: string | undefined) {
  const fixtures = entityIdentityShadowFixtures()
  const requested = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
  if (requested.length === 0) return fixtures
  const selected = fixtures.filter((fixture) => requested.includes(fixture.caseId))
  const missing = requested.filter((caseId) => !selected.some((fixture) => fixture.caseId === caseId))
  if (missing.length > 0) throw new Error(`Unknown Entity identity shadow cases: ${missing.join(', ')}`)
  return selected
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
