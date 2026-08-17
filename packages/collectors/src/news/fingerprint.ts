import { createHash } from 'node:crypto'
import type { NewsCandidateFingerprint, NewsCandidate } from './types'

const TRACKING_PARAMS = new Set(['fbclid', 'gclid'])

export function canonicalArticleUrl(value: string): string {
  const parsed = new URL(value)
  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.hostname = parsed.hostname.toLowerCase()
  parsed.hash = ''

  const keptParams: Array<[string, string]> = []
  for (const [key, paramValue] of parsed.searchParams.entries()) {
    if (key.toLowerCase().startsWith('utm_')) continue
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue
    keptParams.push([key, paramValue])
  }

  keptParams.sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
  ))
  parsed.search = ''
  for (const [key, paramValue] of keptParams) {
    parsed.searchParams.append(key, paramValue)
  }

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }

  return parsed.toString()
}

export function hashText(value: string): string {
  return createHash('sha256')
    .update(normalizeText(value))
    .digest('hex')
}

export function fingerprintNewsCandidate(
  sourceId: string,
  urlId: string,
  candidate: NewsCandidate
): NewsCandidateFingerprint {
  const canonicalUrl = canonicalArticleUrl(candidate.article_url)
  const headlineHash = hashText(candidate.headline)
  const summary = candidate.summary?.trim()
  const summaryHash = summary ? hashText(summary) : null
  const contentHash = hashText([
    candidate.headline,
    summary ?? '',
  ].join('\n'))
  const articleIdentityKey = `${sourceId}:article:${canonicalUrl}`
  const observationDedupeKey = [
    sourceId,
    urlId,
    canonicalUrl,
    headlineHash,
    summaryHash ?? 'none',
  ].join(':')

  return {
    sourceId,
    urlId,
    canonicalArticleUrl: canonicalUrl,
    headlineHash,
    summaryHash,
    contentHash,
    articleIdentityKey,
    observationDedupeKey,
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export const __fingerprintTesting = {
  normalizeText,
}
