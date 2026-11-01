/**
 * Read-only CLI for the #552 internal Atlas browse endpoints.
 *
 *   atlas <signals|analyst|entities|entity-items> [--key value ...]
 *   atlas signals --since 7d --q governance
 *   atlas analyst --decision ignore --limit 20
 *
 * Env: MYBOON_API_URL (API base URL) and INTERNAL_DASHBOARD_TOKEN. The token is
 * sent as a Bearer header and is never printed.
 */
const RESOURCES = ['signals', 'analyst', 'entities', 'entity-items'] as const
type Resource = (typeof RESOURCES)[number]

function usage(code: number): never {
  console.error(`usage: atlas <${RESOURCES.join('|')}> [--since 24h] [--until ISO] [--limit N] [--cursor C] [--all] [--<filter> value]`)
  process.exit(code)
}

function parseArgs(argv: string[]): { resource: Resource; params: URLSearchParams; all: boolean } {
  const [resource, ...rest] = argv
  if (!resource || !RESOURCES.includes(resource as Resource)) usage(resource ? 2 : 0)
  const params = new URLSearchParams()
  let all = false
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--all') { all = true; continue }
    if (!flag.startsWith('--')) usage(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) usage(2)
    params.set(flag.slice(2).replace(/-/g, '_'), value)
    i++
  }
  return { resource: resource as Resource, params, all }
}

async function main(): Promise<void> {
  const { resource, params, all } = parseArgs(process.argv.slice(2))
  const base = process.env.MYBOON_API_URL?.trim()
  const token = process.env.INTERNAL_DASHBOARD_TOKEN?.trim()
  if (!base || !token) {
    console.error('MYBOON_API_URL and INTERNAL_DASHBOARD_TOKEN must be set (see /home/box/secrets/myboon-internal.env)')
    process.exit(2)
  }
  const pages: unknown[] = []
  let cursor = params.get('cursor')
  // --all follows nextCursor, capped at 20 pages to stay egress-friendly.
  for (let page = 0; page < (all ? 20 : 1); page++) {
    if (cursor) params.set('cursor', cursor)
    const url = `${base.replace(/\/$/, '')}/internal/atlas/${resource}?${params}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    const body = await res.json().catch(() => ({ error: `non-JSON response (${res.status})` })) as Record<string, unknown>
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
      process.exit(1)
    }
    pages.push(body)
    cursor = typeof body.nextCursor === 'string' ? body.nextCursor : null
    if (!cursor) break
  }
  console.log(JSON.stringify(all ? pages : pages[0], null, 2))
}

void main()
