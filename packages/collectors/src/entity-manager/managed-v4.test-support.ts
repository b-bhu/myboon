import { createHash } from 'node:crypto'
import type { ResearchPacketV1, ResearchWorkItem, RetrievedEvidence, Signal } from '../signal-platform/contracts'
import { assessResearchReadiness } from '../signal-platform/research-readiness'
import { adaptCanonicalResearchPacket, type EntityHandoffContext } from './canonical-packet-adapter'
import type { CanonicalPacketProcessorInput, EntityPacketWorkPort } from './shared-worker'

export const MANAGED_TEST_NOW = '2026-10-03T12:00:00.000Z'
export const ACME_ID = '11111111-1111-1111-1111-111111111111'

export function managedFixture(suffix: string, options: {source?: 'news'|'polymarket';partial?:boolean;name?:string;role?:string} = {}): CanonicalPacketProcessorInput & {canonicalPacket: ResearchPacketV1; handoffContext:EntityHandoffContext} {
  const source = options.source ?? 'news'
  const name = options.name ?? 'Acme'
  const url = `https://example.com/${suffix}`
  const signal: Signal = {
    schemaVersion:'myboon.signal.v1',signalId:`signal-${suffix}`,sourceType:source,sourceId:`native-${suffix}`,
    contentKind:source === 'news' ? 'article' : 'market_event',
    content:{schemaVersion:source === 'news' ? 'myboon.signal_content.article.v1' : 'myboon.signal_content.market_event.v1',slug:`market-${suffix}`},
    observedAt:MANAGED_TEST_NOW,publishedAt:MANAGED_TEST_NOW,canonicalUrl:url,title:`${name} statement`,visibleSummary:`${name} claims progress`,
    media:{imageUrl:null,attribution:'Fixture'},sourceHints:{entities:[name],assets:[],eventId:`native-${suffix}`,deadline:null},
    provenance:{provider:'fixture',upstreamSource:'Attributed fixture',rawPayloadRef:`fixture://${suffix}`},idempotencyKey:`key-${suffix}`,
  } as Signal
  const work: ResearchWorkItem = {
    schemaVersion:'myboon.research_work.v1',workId:`work-${suffix}`,signalId:signal.signalId,sourceType:source,
    researchDepth:'standard',deepReason:null,priorityClass:'P1',priorityScore:0.8,freshnessDeadline:'2026-10-03T14:00:00.000Z',
    policyVersion:'fixture-policy.v1',researchContractVersion:'myboon.research_packet.v1',
    retrievalPlan:{sourceUrl:url,allowedDomains:['example.com'],maxExternalSources:1},
    budget:{maxProviderCalls:2,maxRepairCalls:1,maxInputTokens:1000,maxOutputTokens:1000,maxWallTimeMs:30_000,maxToolCalls:0},
    status:'entity_pending',attemptCount:0,nextAttemptAt:null,leaseOwner:null,leaseId:null,leaseExpiresAt:null,
    failureCategory:null,failureDetail:null,traceId:`trace-${suffix}`,createdAt:MANAGED_TEST_NOW,updatedAt:MANAGED_TEST_NOW,
  }
  const evidence: RetrievedEvidence = {
    schemaVersion:'myboon.evidence.v1',evidenceId:`evidence-${suffix}`,workId:work.workId,requestedUrl:url,finalUrl:url,
    authority:'source_url',authorityId:signal.signalId,contentHash:createHash('sha256').update('Fixture source body').digest('hex'),
    contentType:'text/html',httpStatus:200,retrievalMethod:'safe_http',retrievedAt:MANAGED_TEST_NOW,
    text:'Fixture source body',truncated:false,byteLength:19,
  }
  const canonicalPacket: ResearchPacketV1 = {
    schemaVersion:'myboon.research_packet.v1',packetId:`packet-${suffix}`,workId:work.workId,signalId:signal.signalId,sourceType:source,observedAt:MANAGED_TEST_NOW,
    sourceSignal:{title:signal.title,canonicalUrl:url,publishedAt:MANAGED_TEST_NOW,provenance:signal.provenance},
    claims:[{claimId:`claim-${suffix}`,claim:`${name} says its project has progressed.`,attributedTo:name,evidenceRefs:[evidence.evidenceId]}],
    verifiedFacts:[],unresolvedClaims:[],evidence:[{evidenceId:evidence.evidenceId,title:'Attributed fixture source',url,sourceType:'source_url',observedAt:MANAGED_TEST_NOW,note:null}],
    entityHints:[{name,type:'organization',role:options.role ?? 'subject',aliases:[],source:'synthesis',claimRefs:[`claim-${suffix}`],evidenceRefs:[evidence.evidenceId]}],
    limitations:['The claim has not been independently verified.'],openQuestions:['What independent confirmation exists?'],completion:options.partial ? 'partial':'complete',
    budgetUsed:{providerCalls:0,repairCalls:0,inputTokens:0,outputTokens:0,wallTimeMs:0,toolCalls:0,budgetExceeded:false},
    execution:{provider:'fixture',model:'mock',fallbackProvider:null,fallbackModel:null,fallbackUsed:false,promptVersion:'fixture-prompt.v1',policyVersion:'fixture-policy.v1',traceId:work.traceId,attempt:0},
    researchContractVersion:'myboon.research_packet.v1',createdAt:MANAGED_TEST_NOW,
  }
  const readiness = assessResearchReadiness({work,signal,packet:canonicalPacket,persistedEvidence:[evidence],assessedAt:MANAGED_TEST_NOW})
  const handoffContext = {work,signal,persistedEvidence:[evidence],readiness}
  return {work,canonicalPacket,handoffContext,packet:adaptCanonicalResearchPacket(canonicalPacket,undefined,handoffContext),signal:new AbortController().signal}
}

export function fixturePort(input: CanonicalPacketProcessorInput & {handoffContext:EntityHandoffContext}): EntityPacketWorkPort {
  return {
    sourceType:input.work.sourceType,
    async peekSchedulable(){return [input.work]},
    async claimWithLease(){throw new Error('fixture does not claim work')},
    async heartbeatLease(){return true},async transitionLeased(){return true},async releaseLease(){return true},
    async readResearchPacket(workId){return workId === input.work.workId ? input.canonicalPacket:null},
    async readHandoffContext(){return input.handoffContext},
  }
}
