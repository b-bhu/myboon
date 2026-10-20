'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  InternalEntityDetailResponse,
  InternalEntityListItem,
  InternalEntityListResponse,
  InternalEntityMemoryItem,
  InternalEntityTimelineResponse,
} from './types'
import styles from './styles.module.css'

type SortMode = 'updated_desc' | 'memory_count_desc' | 'name_asc'

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: 'updated_desc', label: 'Recently updated' },
  { value: 'memory_count_desc', label: 'Most memories' },
  { value: 'name_asc', label: 'A to Z' },
]

export function EntityMemoryBrowser() {
  const [entities, setEntities] = useState<InternalEntityListItem[]>([])
  const [entityCursor, setEntityCursor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<InternalEntityDetailResponse | null>(null)
  const [memories, setMemories] = useState<InternalEntityMemoryItem[]>([])
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sort, setSort] = useState<SortMode>('updated_desc')
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Set<string>>(new Set())
  const [isLoadingEntities, setIsLoadingEntities] = useState(true)
  const [isLoadingMoreEntities, setIsLoadingMoreEntities] = useState(false)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [isLoadingMoreMemories, setIsLoadingMoreMemories] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entityListRequest = useRef(0)
  const entityDetailRequest = useRef(0)

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void loadEntities()
    }, 160)
    return () => window.clearTimeout(handle)
  }, [query, typeFilter, statusFilter, sort])

  useEffect(() => {
    if (selectedId) void loadSelectedEntity(selectedId)
  }, [selectedId])

  const typeOptions = useMemo(() => {
    return [...new Set(entities.map((entity) => entity.type).filter(Boolean))].sort()
  }, [entities])

  const statusOptions = useMemo(() => {
    return [...new Set(entities.map((entity) => entity.status).filter(Boolean))].sort()
  }, [entities])

  async function loadEntities(cursor: string | null = null) {
    const requestId = ++entityListRequest.current
    const isLoadingMore = Boolean(cursor)
    if (isLoadingMore) setIsLoadingMoreEntities(true)
    else setIsLoadingEntities(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      if (typeFilter) params.set('type', typeFilter)
      if (statusFilter) params.set('status', statusFilter)
      params.set('sort', sort)
      params.set('limit', '80')
      if (cursor) params.set('cursor', cursor)

      const res = await fetch(`/internal/entities/api/entities?${params.toString()}`, { cache: 'no-store' })
      if (res.status === 401) {
        window.location.reload()
        return
      }
      if (!res.ok) throw new Error(await readableError(res))

      const body = await res.json() as InternalEntityListResponse
      if (requestId !== entityListRequest.current) return

      setEntityCursor(body.nextCursor)
      setEntities((current) => isLoadingMore ? mergeById(current, body.entities) : body.entities)
      if (!isLoadingMore) {
        setSelectedId((current) => {
          if (current && body.entities.some((entity) => entity.id === current)) return current
          return body.entities[0]?.id ?? null
        })
      }
      if (!isLoadingMore && body.entities.length === 0) {
        setDetail(null)
        setMemories([])
        setTimelineCursor(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load entities')
    } finally {
      if (requestId === entityListRequest.current) {
        setIsLoadingEntities(false)
        setIsLoadingMoreEntities(false)
      }
    }
  }

  async function loadSelectedEntity(entityId: string, cursor: string | null = null) {
    const requestId = ++entityDetailRequest.current
    const isLoadingMore = Boolean(cursor)
    if (isLoadingMore) setIsLoadingMoreMemories(true)
    else setIsLoadingDetail(true)
    setError(null)
    try {
      const timelineParams = new URLSearchParams({ limit: '40' })
      if (cursor) timelineParams.set('cursor', cursor)
      const timelineRequest = fetch(
        `/internal/entities/api/entities/${encodeURIComponent(entityId)}/timeline?${timelineParams.toString()}`,
        { cache: 'no-store' },
      )
      const detailRequest = isLoadingMore
        ? null
        : fetch(`/internal/entities/api/entities/${encodeURIComponent(entityId)}`, { cache: 'no-store' })
      const [detailRes, timelineRes] = await Promise.all([detailRequest, timelineRequest])
      if (detailRes?.status === 401 || timelineRes.status === 401) {
        window.location.reload()
        return
      }
      if (detailRes && !detailRes.ok) throw new Error(await readableError(detailRes))
      if (!timelineRes.ok) throw new Error(await readableError(timelineRes))
      if (requestId !== entityDetailRequest.current) return

      const timelineBody = await timelineRes.json() as InternalEntityTimelineResponse
      setTimelineCursor(timelineBody.nextCursor)
      if (detailRes) {
        setDetail(await detailRes.json() as InternalEntityDetailResponse)
        setMemories(timelineBody.memories)
        setExpandedMemoryIds(new Set())
      } else {
        setMemories((current) => mergeById(current, timelineBody.memories))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load entity memory')
    } finally {
      if (requestId === entityDetailRequest.current) {
        setIsLoadingDetail(false)
        setIsLoadingMoreMemories(false)
      }
    }
  }

  async function logout() {
    await fetch('/internal/session', { method: 'DELETE', credentials: 'same-origin' })
    window.location.reload()
  }

  function toggleMemory(memoryId: string) {
    setExpandedMemoryIds((current) => {
      const next = new Set(current)
      if (next.has(memoryId)) {
        next.delete(memoryId)
      } else {
        next.add(memoryId)
      }
      return next
    })
  }

  const selectedEntity = detail?.entity
  const selectedListItem = entities.find((entity) => entity.id === selectedId)
  const stats = detail?.stats

  return (
    <main className={styles.browserShell}>
      <aside className={styles.folderRail}>
        <header className={styles.railHeader}>
          <div className={styles.brandRow}>
            <span className={styles.brandMark}>m</span>
            <div>
              <div className={styles.brandName}>myboon</div>
              <div className={styles.brandMeta}>entity memory</div>
            </div>
          </div>
          <div className={styles.searchBox}>
            <span className="material-symbols-outlined" aria-hidden="true">search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search entities"
              aria-label="Search entities"
            />
          </div>
          <div className={styles.filterGrid}>
            <label>
              <span>Type</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="">All</option>
                {typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">All</option>
                {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
          </div>
          <label className={styles.sortControl}>
            <span>Sort</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </header>

        <div className={styles.folderListHeader}>
          <span>{entities.length} folders</span>
          {isLoadingEntities ? <span>Loading</span> : null}
        </div>

        <div className={styles.folderList}>
          {entities.map((entity) => (
            <button
              key={entity.id}
              className={`${styles.folderButton} ${entity.id === selectedId ? styles.folderButtonActive : ''}`}
              type="button"
              onClick={() => setSelectedId(entity.id)}
            >
              <span className={styles.folderShape} data-type={entity.type} aria-hidden="true" />
              <span className={styles.folderText}>
                <span className={styles.folderName}>{entity.name}</span>
                <span className={styles.folderMeta}>
                  {entity.type} / {entity.status}{entity.showInCarousel ? ' / carousel' : ''} / {relativeTime(entity.latestMemoryAt ?? entity.updatedAt)}
                </span>
              </span>
              <span className={styles.folderCount}>
                {formatNumber(entity.memoryCount)}
                <span>mem</span>
              </span>
            </button>
          ))}
          {!isLoadingEntities && entities.length === 0 ? (
            <div className={styles.emptyRail}>No matching entities.</div>
          ) : null}
          {entityCursor ? (
            <button
              className={styles.loadMoreButton}
              type="button"
              disabled={isLoadingMoreEntities}
              onClick={() => void loadEntities(entityCursor)}
            >
              {isLoadingMoreEntities ? 'Loading folders...' : 'Load more folders'}
            </button>
          ) : null}
        </div>
      </aside>

      <section className={styles.memoryPane}>
        <header className={styles.topBar}>
          <div className={styles.entityHeader}>
            <div className={styles.entityBadge}>{initials(selectedEntity?.name ?? selectedListItem?.name ?? 'Entity')}</div>
            <div className={styles.entityTitleBlock}>
              <p className={styles.kicker}>Selected entity</p>
              <h1>{selectedEntity?.name ?? selectedListItem?.name ?? 'No entity selected'}</h1>
              <div className={styles.entitySubline}>
                {selectedEntity ? `${selectedEntity.type} / ${selectedEntity.status} / ${selectedEntity.slug}${selectedEntity.showInCarousel ? ' / carousel' : ''}` : 'Choose a folder to inspect memory.'}
              </div>
            </div>
          </div>
          <div className={styles.topActions}>
            <Link className={styles.textButton} href="/internal/polymarket">
              <span className="material-symbols-outlined" aria-hidden="true">monitoring</span>
              Polymarket
            </Link>
            <button className={styles.iconButton} type="button" title="Reload" onClick={() => selectedId && loadSelectedEntity(selectedId)}>
              <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
            </button>
            <button className={styles.textButton} type="button" onClick={logout}>
              <span className="material-symbols-outlined" aria-hidden="true">logout</span>
              Sign out
            </button>
          </div>
        </header>

        {error ? <div className={styles.errorBanner}>{error}</div> : null}

        <section className={styles.statGrid} aria-label="Entity stats">
          <Stat label="Memories" value={stats ? formatNumber(stats.memoryCount) : '--'} note={stats?.latestMemoryAt ? `Latest ${relativeTime(stats.latestMemoryAt)}` : 'No saved memory'} />
          <Stat label="Sources" value={stats ? formatNumber(stats.sourceCount) : '--'} note="Distinct memory sources" />
          <Stat label="Evidence" value={stats ? formatNumber(stats.evidenceCount) : '--'} note="Evidence items sampled" />
          <Stat label="Related" value={stats ? formatNumber(stats.relatedEntityCount) : '--'} note={`${stats?.publishedNarrativeCount ?? 0} published links`} />
        </section>

        <section className={styles.workspaceGrid}>
          <article className={styles.timelinePanel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>Timeline</h2>
                <p>{memories.length} memories, newest first</p>
              </div>
              {isLoadingDetail ? <span className={styles.loadingPill}>Loading</span> : <span className={styles.loadingPill}>Recent to old</span>}
            </div>

            <div className={styles.timelineList}>
              {memories.map((memory) => (
                <MemoryEvent
                  key={memory.id}
                  memory={memory}
                  isExpanded={expandedMemoryIds.has(memory.id)}
                  onToggle={() => toggleMemory(memory.id)}
                />
              ))}
              {!isLoadingDetail && selectedId && memories.length === 0 ? (
                <div className={styles.emptyTimeline}>No memory rows are attached to this entity yet.</div>
              ) : null}
              {timelineCursor && selectedId ? (
                <button
                  className={styles.loadMoreButton}
                  type="button"
                  disabled={isLoadingMoreMemories}
                  onClick={() => void loadSelectedEntity(selectedId, timelineCursor)}
                >
                  {isLoadingMoreMemories ? 'Loading memories...' : 'Load older memories'}
                </button>
              ) : null}
            </div>
          </article>

          <aside className={styles.sideRail}>
            <section className={styles.sidePanel}>
              <h2>Entity note</h2>
              <p>{selectedEntity?.summary ?? 'No summary saved for this entity.'}</p>
              {selectedEntity?.aliases.length ? (
                <div className={styles.aliasRow}>
                  {selectedEntity.aliases.slice(0, 8).map((alias) => <span key={alias}>{alias}</span>)}
                </div>
              ) : null}
            </section>

            <section className={styles.sidePanel}>
              <h2>Related entities</h2>
              <div className={styles.relatedList}>
                {detail?.relatedEntities.length ? detail.relatedEntities.map((entity) => (
                  <button
                    key={entity.id}
                    className={styles.relatedItem}
                    type="button"
                    onClick={() => setSelectedId(entity.id)}
                  >
                    <span>{initials(entity.name)}</span>
                    <strong>{entity.name}</strong>
                    <small>{entity.reason}</small>
                  </button>
                )) : <p>No related entities inferred yet.</p>}
              </div>
            </section>

            <section className={styles.sidePanel}>
              <h2>Database row</h2>
              <dl className={styles.rawRefs}>
                <div>
                  <dt>entity_id</dt>
                  <dd>{selectedEntity?.id ?? '--'}</dd>
                </div>
                <div>
                  <dt>slug</dt>
                  <dd>{selectedEntity?.slug ?? '--'}</dd>
                </div>
                <div>
                  <dt>created</dt>
                  <dd>{formatDate(selectedEntity?.createdAt)}</dd>
                </div>
                <div>
                  <dt>updated</dt>
                  <dd>{formatDate(selectedEntity?.updatedAt)}</dd>
                </div>
              </dl>
            </section>
          </aside>
        </section>
      </section>
    </main>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className={styles.statCard}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  )
}

function MemoryEvent({ memory, isExpanded, onToggle }: {
  memory: InternalEntityMemoryItem
  isExpanded: boolean
  onToggle: () => void
}) {
  const evidenceCount = memory.evidence.length
  const confidence = memory.confidence === null ? null : `${Math.round(memory.confidence * 100)}%`

  return (
    <article className={styles.memoryEvent}>
      <div className={styles.eventTime}>
        <strong>{formatDate(memory.observedAt, 'date')}</strong>
        <span>{formatDate(memory.observedAt, 'time')}</span>
      </div>
      <div className={styles.eventMarker} aria-hidden="true">
        <span className="material-symbols-outlined">description</span>
      </div>
      <div className={styles.eventBody}>
        <div className={styles.eventTopline}>
          <span>{memory.memoryType}</span>
          <span>{memory.source} / {memory.sourceArea}</span>
          {confidence ? <span>{confidence}</span> : null}
        </div>
        <h3>{memory.title}</h3>
        <p>{memory.summary}</p>
        <div className={styles.eventMeta}>
          <span>{evidenceCount} evidence</span>
          <span>{memory.mentions.length} mentions</span>
          <span>{memory.sourceResearchId}</span>
        </div>
        <button className={styles.expandButton} type="button" onClick={onToggle}>
          <span className="material-symbols-outlined" aria-hidden="true">{isExpanded ? 'expand_less' : 'expand_more'}</span>
          {isExpanded ? 'Hide details' : 'Show details'}
        </button>
        {isExpanded ? (
          <div className={styles.memoryDetails}>
            {memory.body ? <p>{memory.body}</p> : null}
            <JsonBlock label="Evidence" value={memory.evidence} />
            <JsonBlock label="Mentions" value={memory.mentions} />
            <JsonBlock label="Metrics" value={memory.metrics} />
            <JsonBlock label="Context" value={memory.context} />
            <dl>
              <div>
                <dt>source_ref_id</dt>
                <dd>{memory.sourceRefId}</dd>
              </div>
              <div>
                <dt>source_research_id</dt>
                <dd>{memory.sourceResearchId}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </div>
    </article>
  )
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <details className={styles.jsonDetails}>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}

async function readableError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string } | null
  return body?.error ?? `Request failed with ${res.status}`
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'E'
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}

function formatDate(value: string | null | undefined, part: 'date' | 'time' | 'both' = 'both'): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  if (part === 'date') {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' }).format(date)
  }
  if (part === 'time') {
    return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(date)
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

function relativeTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000)
  const absSeconds = Math.abs(diffSeconds)
  const formatter = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
  if (absSeconds < 60) return formatter.format(diffSeconds, 'second')
  const diffMinutes = Math.round(diffSeconds / 60)
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour')
  const diffDays = Math.round(diffHours / 24)
  return formatter.format(diffDays, 'day')
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !seen.has(item.id))]
}
