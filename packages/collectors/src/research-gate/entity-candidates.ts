/** Rank before bounding so generic summaries cannot crowd out exact identities. */
export function rankEntityCandidates<T extends {
  id: string, name: string, slug?: string, aliases?: string[], summary: string | null,
  metadata?: Record<string, unknown>, scope?: Record<string, unknown>,
}>(entities: readonly T[], labels: readonly string[], limit = 32): T[] {
  const terms = [...new Set(labels.map(normalize).filter(Boolean))]
  const unique = [...new Map(entities.map(entity => [entity.id, entity])).values()]
  const score = (entity: T): number => {
    const names = [entity.name, entity.slug ?? '', ...(entity.aliases ?? [])].map(normalize).filter(Boolean)
    const exact = terms.some(term => names.includes(term))
    const nameHits = terms.filter(term => names.some(name => name.includes(term))).length
    const context = normalize(JSON.stringify(entity.scope ?? entity.metadata ?? {}))
    const summary = normalize(entity.summary ?? '')
    return Number(exact) * 100_000 + nameHits * 1_000
      + terms.filter(term => context.includes(term)).length * 10
      + terms.filter(term => summary.includes(term)).length
  }
  return unique.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, limit)
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US')
}
