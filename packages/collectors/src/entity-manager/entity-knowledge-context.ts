import type { ResearchPacketV1 } from '../signal-platform/contracts'
import type { EntityRecord } from './types'

export const ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION = 'myboon.entity_admission_knowledge.v1' as const
export const ENTITY_ADMISSION_KNOWLEDGE_MAX_CLASSIFICATIONS = 12
export const ENTITY_ADMISSION_KNOWLEDGE_MAX_RELATIONSHIPS = 12

export const ENTITY_KIND_V1_VALUES = [
  'person',
  'organization',
  'network',
  'protocol',
  'product',
  'asset',
  'place',
  'event',
  'topic',
  'regulation',
  'unclassified',
] as const

export const ENTITY_CLASSIFICATION_SCHEME_V1_VALUES = [
  'domain',
  'ecosystem',
  'sector',
  'function',
  'asset_class',
] as const

export const ENTITY_RELATIONSHIP_PREDICATE_V1_VALUES = [
  'native_asset_of',
  'has_native_asset',
  'token_of',
  'has_token',
  'issued_on',
  'product_of',
  'has_product',
  'operates_on',
] as const

export type EntityKindV1 = typeof ENTITY_KIND_V1_VALUES[number]
export type EntityClassificationSchemeV1 = typeof ENTITY_CLASSIFICATION_SCHEME_V1_VALUES[number]
export type EntityRelationshipPredicateV1 = typeof ENTITY_RELATIONSHIP_PREDICATE_V1_VALUES[number]
export type EntityRelationshipDirectionV1 = 'outgoing' | 'incoming'

export interface ReviewedEntityKnowledgeProvenanceV1 {
  kind: 'reviewed_record'
  /** Durable review record, checked-in fixture, or later database record ID. */
  reference: string
}

export interface EntityKnowledgeClassificationV1 {
  /** Stable `${scheme}:${slug}` identity. */
  conceptId: string
  scheme: EntityClassificationSchemeV1
  slug: string
  name: string
  /** Direct hierarchy from root to this concept; the final member is `slug`. */
  path: string[]
  verificationStatus: 'reviewed'
  provenance: ReviewedEntityKnowledgeProvenanceV1
}

export interface EntityKnowledgeRelatedEntityV1 {
  id: string
  slug: string
  name: string
  kind: EntityKindV1
}

export interface EntityKnowledgeRelationshipV1 {
  predicate: EntityRelationshipPredicateV1
  direction: EntityRelationshipDirectionV1
  relatedEntity: EntityKnowledgeRelatedEntityV1
  verificationStatus: 'reviewed'
  provenance: ReviewedEntityKnowledgeProvenanceV1
}

/**
 * Bounded, reviewed context supplied to canonical Entity admission. This is
 * deliberately not a persistence or public API contract. The scoped V1 has no
 * model-authored knowledge and performs no classification/relationship writes.
 */
export interface EntityAdmissionKnowledgeContextV1 {
  schemaVersion: typeof ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION
  entityId: string
  kind: EntityKindV1
  classifications: EntityKnowledgeClassificationV1[]
  relationships: EntityKnowledgeRelationshipV1[]
}

export interface GetEntityAdmissionKnowledgeInput {
  entities: readonly EntityRecord[]
  packet: ResearchPacketV1
  signal: AbortSignal
}

export interface EntityAdmissionKnowledgePort {
  getEntityAdmissionKnowledge(
    input: GetEntityAdmissionKnowledgeInput,
  ): Promise<readonly EntityAdmissionKnowledgeContextV1[]>
}

export class EntityAdmissionKnowledgeValidationError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'EntityAdmissionKnowledgeValidationError'
  }
}

/**
 * Explicit read-only compatibility projection for legacy `entities.type`.
 * Ambiguous values do not silently become `topic`; reviewed knowledge may
 * override `unclassified` without rewriting the legacy row.
 */
export function legacyEntityTypeToKindV1(type: string): EntityKindV1 {
  const normalized = type.trim().toLowerCase().replace(/[\s-]+/g, '_')
  switch (normalized) {
    case 'person':
      return 'person'
    case 'organization':
    case 'company':
      return 'organization'
    case 'network':
      return 'network'
    case 'protocol':
      return 'protocol'
    case 'product':
    case 'ai_model':
      return 'product'
    case 'asset':
    case 'commodity':
    case 'currency':
    case 'index':
    case 'instrument':
    case 'asset_class':
      return 'asset'
    case 'country':
    case 'nation':
    case 'geo':
    case 'place':
    case 'location':
      return 'place'
    case 'event':
      return 'event'
    case 'topic':
    case 'market_theme':
    case 'sector':
    case 'indicator':
    case 'geopolitical_topic':
    case 'event_market':
      return 'topic'
    case 'regulation':
    case 'legislation':
    case 'regulation_or_initiative':
      return 'regulation'
    // `project` and `platform` are intentionally ambiguous: either can refer
    // to an organization, protocol, product, or umbrella brand.
    case 'project':
    case 'platform':
    default:
      return 'unclassified'
  }
}

export function validateEntityAdmissionKnowledge(
  value: unknown,
  requestedEntityIds: ReadonlySet<string>,
): EntityAdmissionKnowledgeContextV1[] {
  if (!Array.isArray(value)) {
    throw new EntityAdmissionKnowledgeValidationError('Entity admission knowledge must be an array.')
  }
  if (value.length > requestedEntityIds.size) {
    throw new EntityAdmissionKnowledgeValidationError('Entity admission knowledge exceeds the requested Entity count.')
  }

  const seenEntityIds = new Set<string>()
  const contexts = value.map((item, index): EntityAdmissionKnowledgeContextV1 => {
    const record = object(item, `knowledge[${index}]`)
    if (record.schemaVersion !== ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION) {
      throw new EntityAdmissionKnowledgeValidationError(
        `knowledge[${index}].schemaVersion must be ${ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION}.`,
      )
    }
    const entityId = text(record.entityId, `knowledge[${index}].entityId`, 200)
    if (!requestedEntityIds.has(entityId)) {
      throw new EntityAdmissionKnowledgeValidationError(`knowledge[${index}] references an unrequested Entity: ${entityId}`)
    }
    if (seenEntityIds.has(entityId)) {
      throw new EntityAdmissionKnowledgeValidationError(`Duplicate Entity admission knowledge: ${entityId}`)
    }
    seenEntityIds.add(entityId)

    const classifications = array(record.classifications, `knowledge[${index}].classifications`)
    if (classifications.length > ENTITY_ADMISSION_KNOWLEDGE_MAX_CLASSIFICATIONS) {
      throw new EntityAdmissionKnowledgeValidationError(
        `knowledge[${index}].classifications exceeds ${ENTITY_ADMISSION_KNOWLEDGE_MAX_CLASSIFICATIONS}.`,
      )
    }
    const relationships = array(record.relationships, `knowledge[${index}].relationships`)
    if (relationships.length > ENTITY_ADMISSION_KNOWLEDGE_MAX_RELATIONSHIPS) {
      throw new EntityAdmissionKnowledgeValidationError(
        `knowledge[${index}].relationships exceeds ${ENTITY_ADMISSION_KNOWLEDGE_MAX_RELATIONSHIPS}.`,
      )
    }

    return {
      schemaVersion: ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION,
      entityId,
      kind: enumValue(record.kind, ENTITY_KIND_V1_VALUES, `knowledge[${index}].kind`),
      classifications: uniqueClassifications(classifications.map((classification, classificationIndex) => (
        classificationValue(classification, `knowledge[${index}].classifications[${classificationIndex}]`)
      ))),
      relationships: uniqueRelationships(relationships.map((relationship, relationshipIndex) => (
        relationshipValue(relationship, `knowledge[${index}].relationships[${relationshipIndex}]`)
      ))),
    }
  })

  return contexts.sort((left, right) => compareStrings(left.entityId, right.entityId))
}

/** Test/scoped-rollout provider over reviewed records; it never mutates them. */
export class StaticEntityAdmissionKnowledgeProvider implements EntityAdmissionKnowledgePort {
  private readonly contexts: EntityAdmissionKnowledgeContextV1[]

  constructor(contexts: readonly EntityAdmissionKnowledgeContextV1[]) {
    const entityIds = new Set(contexts.map((context) => context.entityId))
    this.contexts = validateEntityAdmissionKnowledge(contexts, entityIds)
  }

  async getEntityAdmissionKnowledge(
    input: GetEntityAdmissionKnowledgeInput,
  ): Promise<readonly EntityAdmissionKnowledgeContextV1[]> {
    if (input.signal.aborted) throw new Error('Entity admission knowledge lookup was aborted.')
    const requested = new Set(input.entities.map((entity) => entity.id))
    return this.contexts
      .filter((context) => requested.has(context.entityId))
      .map(cloneContext)
  }
}

function classificationValue(value: unknown, field: string): EntityKnowledgeClassificationV1 {
  const record = object(value, field)
  const scheme = enumValue(record.scheme, ENTITY_CLASSIFICATION_SCHEME_V1_VALUES, `${field}.scheme`)
  const slug = canonicalSlug(record.slug, `${field}.slug`)
  const conceptId = text(record.conceptId, `${field}.conceptId`, 200)
  if (conceptId !== `${scheme}:${slug}`) {
    throw new EntityAdmissionKnowledgeValidationError(`${field}.conceptId must equal ${scheme}:${slug}.`)
  }
  const path = array(record.path, `${field}.path`).map((item, index) => canonicalSlug(item, `${field}.path[${index}]`))
  if (path.length < 1 || path.length > 6 || path.at(-1) !== slug) {
    throw new EntityAdmissionKnowledgeValidationError(`${field}.path must contain 1-6 concepts and end with its slug.`)
  }
  return {
    conceptId,
    scheme,
    slug,
    name: text(record.name, `${field}.name`, 120),
    path,
    verificationStatus: reviewed(record.verificationStatus, `${field}.verificationStatus`),
    provenance: provenanceValue(record.provenance, `${field}.provenance`),
  }
}

function relationshipValue(value: unknown, field: string): EntityKnowledgeRelationshipV1 {
  const record = object(value, field)
  const related = object(record.relatedEntity, `${field}.relatedEntity`)
  return {
    predicate: enumValue(record.predicate, ENTITY_RELATIONSHIP_PREDICATE_V1_VALUES, `${field}.predicate`),
    direction: enumValue(record.direction, ['outgoing', 'incoming'] as const, `${field}.direction`),
    relatedEntity: {
      id: text(related.id, `${field}.relatedEntity.id`, 200),
      slug: canonicalSlug(related.slug, `${field}.relatedEntity.slug`),
      name: text(related.name, `${field}.relatedEntity.name`, 120),
      kind: enumValue(related.kind, ENTITY_KIND_V1_VALUES, `${field}.relatedEntity.kind`),
    },
    verificationStatus: reviewed(record.verificationStatus, `${field}.verificationStatus`),
    provenance: provenanceValue(record.provenance, `${field}.provenance`),
  }
}

function provenanceValue(value: unknown, field: string): ReviewedEntityKnowledgeProvenanceV1 {
  const record = object(value, field)
  if (record.kind !== 'reviewed_record') {
    throw new EntityAdmissionKnowledgeValidationError(`${field}.kind must be reviewed_record.`)
  }
  return { kind: 'reviewed_record', reference: text(record.reference, `${field}.reference`, 500) }
}

function uniqueClassifications(values: EntityKnowledgeClassificationV1[]): EntityKnowledgeClassificationV1[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.conceptId)) {
      throw new EntityAdmissionKnowledgeValidationError(`Duplicate Entity classification: ${value.conceptId}`)
    }
    seen.add(value.conceptId)
  }
  return values.sort((left, right) => compareStrings(left.conceptId, right.conceptId))
}

function uniqueRelationships(values: EntityKnowledgeRelationshipV1[]): EntityKnowledgeRelationshipV1[] {
  const seen = new Set<string>()
  for (const value of values) {
    const identity = `${value.direction}:${value.predicate}:${value.relatedEntity.id}`
    if (seen.has(identity)) {
      throw new EntityAdmissionKnowledgeValidationError(`Duplicate Entity relationship: ${identity}`)
    }
    seen.add(identity)
  }
  return values.sort((left, right) => compareStrings(
    `${left.direction}:${left.predicate}:${left.relatedEntity.id}`,
    `${right.direction}:${right.predicate}:${right.relatedEntity.id}`,
  ))
}

function cloneContext(context: EntityAdmissionKnowledgeContextV1): EntityAdmissionKnowledgeContextV1 {
  return {
    ...context,
    classifications: context.classifications.map((classification) => ({
      ...classification,
      path: [...classification.path],
      provenance: { ...classification.provenance },
    })),
    relationships: context.relationships.map((relationship) => ({
      ...relationship,
      relatedEntity: { ...relationship.relatedEntity },
      provenance: { ...relationship.provenance },
    })),
  }
}

function reviewed(value: unknown, field: string): 'reviewed' {
  if (value !== 'reviewed') throw new EntityAdmissionKnowledgeValidationError(`${field} must be reviewed.`)
  return 'reviewed'
}

function canonicalSlug(value: unknown, field: string): string {
  const slug = text(value, field, 120)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new EntityAdmissionKnowledgeValidationError(`${field} must be a canonical lowercase slug.`)
  }
  return slug
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new EntityAdmissionKnowledgeValidationError(`${field} has an unsupported value.`)
  }
  return value as T[number]
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EntityAdmissionKnowledgeValidationError(`${field} must be an object.`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new EntityAdmissionKnowledgeValidationError(`${field} must be an array.`)
  return value
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new EntityAdmissionKnowledgeValidationError(`${field} must be a non-empty string up to ${maximum} characters.`)
  }
  return value.trim()
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
