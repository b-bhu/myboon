import { proxyInternalApi } from '../../../_lib/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_QUERY_KEYS = new Set([
  'sourceKind',
  'sourceSlug',
  'category',
  'sport',
  'windowDays',
  'limit',
])

export async function GET(request: Request) {
  const incoming = new URL(request.url).searchParams
  const query = new URLSearchParams()
  for (const [key, value] of incoming) {
    if (ALLOWED_QUERY_KEYS.has(key)) query.set(key, value)
  }

  return proxyInternalApi(
    `/internal/polymarket/collections/preview?${query.toString()}`,
    {
      configurationMessage: 'Internal Polymarket catalog is unavailable',
      unavailableMessage: 'Polymarket source preview is unavailable',
    },
  )
}
