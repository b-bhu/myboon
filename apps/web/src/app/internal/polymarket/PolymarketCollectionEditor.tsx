'use client'

import Link from 'next/link'
import { FormEvent, useEffect, useState } from 'react'
import styles from './styles.module.css'
import type {
  PolymarketCatalogCollectionResponse,
  PolymarketCatalogItem,
  PolymarketCatalogItemInput,
  PolymarketCatalogSourceKind,
  PolymarketSportsRuleOption,
  PolymarketSportsRuleOptionsResponse,
  PublishPolymarketCatalogDraftRequest,
  SavePolymarketCatalogDraftRequest,
} from './types'

const COLLECTION_KEY = 'featured'
const COLLECTION_ENDPOINT = `/internal/polymarket/api/collections/${COLLECTION_KEY}`
const SPORTS_OPTIONS_ENDPOINT = '/internal/polymarket/api/options/sports'
const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/
// A whole-sport source expands one tag into every league beneath it, so it needs
// a higher ceiling than a single-league rule — cricket alone runs ~55 fixtures
// in a two-week window.
const TAG_MAX_LIMIT = 100

interface EditorItem extends PolymarketCatalogItemInput {
  clientId: string
  title: string
}

/** Both automatic kinds carry a ruleConfig and sports metadata. */
function isRuleKind(kind: PolymarketCatalogSourceKind): boolean {
  return kind === 'sports_rule' || kind === 'sports_tag'
}

interface AddItemForm {
  sourceKind: PolymarketCatalogSourceKind
  sourceSlug: string
  category: string
  sport: string
  windowDays: string
  limit: string
}

const EMPTY_FORM: AddItemForm = {
  sourceKind: 'sports_rule',
  sourceSlug: '',
  category: '',
  sport: '',
  windowDays: '14',
  limit: '20',
}

export function PolymarketCollectionEditor() {
  const [collectionState, setCollectionState] = useState<PolymarketCatalogCollectionResponse | null>(null)
  const [items, setItems] = useState<EditorItem[]>([])
  const [form, setForm] = useState<AddItemForm>(EMPTY_FORM)
  const [sportsOptions, setSportsOptions] = useState<PolymarketSportsRuleOption[]>([])
  const [sportsOptionsError, setSportsOptionsError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [isConflict, setIsConflict] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void loadCollection()
    void loadSportsOptions()
  }, [])

  async function loadSportsOptions() {
    try {
      const response = await fetch(SPORTS_OPTIONS_ENDPOINT, { cache: 'no-store' })
      if (!response.ok) throw new Error('metadata unavailable')
      const body = await response.json() as PolymarketSportsRuleOptionsResponse
      setSportsOptions(Array.isArray(body.options) ? body.options : [])
      setSportsOptionsError(false)
    } catch {
      setSportsOptionsError(true)
    }
  }

  async function loadCollection() {
    setIsLoading(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(COLLECTION_ENDPOINT, { cache: 'no-store' })
      if (response.status === 401) {
        window.location.reload()
        return
      }
      if (!response.ok) throw new Error(await readableError(response))
      applyCollectionState(await response.json() as PolymarketCatalogCollectionResponse)
      setIsDirty(false)
      setIsConflict(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load the featured collection')
    } finally {
      setIsLoading(false)
    }
  }

  function applyCollectionState(nextState: PolymarketCatalogCollectionResponse) {
    setCollectionState(nextState)
    const releaseItems = nextState.draft?.items ?? nextState.published?.items ?? []
    setItems([...releaseItems]
      .sort((left, right) => left.position - right.position)
      .map(toEditorItem))
  }

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)

    const sourceSlug = form.sourceSlug.trim()
    const category = form.category.trim()
    const sport = form.sport.trim()
    if (!SAFE_SLUG_RE.test(sourceSlug)) {
      setError('Use a valid Polymarket slug containing letters, numbers, underscores, or hyphens.')
      return
    }
    if (category.length > 64 || sport.length > 64) {
      setError('Category and sport must each be 64 characters or fewer.')
      return
    }
    if (form.sourceKind === 'event' && !sport) {
      setError('A sport is required for individual event sources.')
      return
    }
    const windowDays = Number(form.windowDays)
    const ruleLimit = Number(form.limit)
    if (form.sourceKind === 'sports_rule' && (
      !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 30
      || !Number.isSafeInteger(ruleLimit) || ruleLimit < 1 || ruleLimit > 50
    )) {
      setError('Automatic sources need a 1–30 day window and a 1–50 game limit.')
      return
    }
    if (form.sourceKind === 'sports_tag' && (
      !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 30
      || !Number.isSafeInteger(ruleLimit) || ruleLimit < 1 || ruleLimit > TAG_MAX_LIMIT
    )) {
      setError(`Whole-sport sources need a 1–30 day window and a 1–${TAG_MAX_LIMIT} game limit.`)
      return
    }
    if (items.some((item) => item.sourceKind === form.sourceKind && item.sourceSlug === sourceSlug)) {
      setError(`The ${form.sourceKind} “${sourceSlug}” is already in this collection.`)
      return
    }

    setItems((current) => [...current, {
      clientId: createClientId(),
      sourceKind: form.sourceKind,
      sourceSlug,
      title: sourceSlug,
      category: isRuleKind(form.sourceKind) ? 'sports' : category || null,
      sport: isRuleKind(form.sourceKind) ? null : sport || null,
      ruleConfig: isRuleKind(form.sourceKind)
        ? { windowDays, limit: ruleLimit, marketType: 'moneyline' }
        : null,
    }])
    setForm((current) => ({ ...EMPTY_FORM, sourceKind: current.sourceKind }))
    markDirty()
  }

  function updateItem(clientId: string, field: 'category' | 'sport', value: string) {
    setItems((current) => current.map((item) => item.clientId === clientId
      ? { ...item, [field]: value }
      : item))
    markDirty()
  }

  function updateRuleItem(clientId: string, field: 'windowDays' | 'limit', value: string) {
    if (value === '') return
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) return
    const item = items.find((candidate) => candidate.clientId === clientId)
    const kindCeiling = item?.sourceKind === 'sports_tag' ? TAG_MAX_LIMIT : 50
    const maximum = field === 'windowDays'
      ? 30
      : Math.min(kindCeiling, collectionState?.collection.defaultLimit ?? kindCeiling)
    const normalized = Math.max(1, Math.min(maximum, parsed))
    setItems((current) => current.map((item) => item.clientId === clientId && item.ruleConfig
      ? { ...item, ruleConfig: { ...item.ruleConfig, [field]: normalized } }
      : item))
    markDirty()
  }

  function selectSourceMode(mode: 'whole-sport' | 'automatic' | 'individual') {
    setForm(mode === 'whole-sport'
      ? { ...EMPTY_FORM, sourceKind: 'sports_tag', sourceSlug: 'cricket', limit: '60' }
      : mode === 'automatic'
        ? { ...EMPTY_FORM, sourceKind: 'sports_rule' }
        : { ...EMPTY_FORM, sourceKind: 'event' })
    setError(null)
    setNotice(null)
  }

  function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= items.length) return
    setItems((current) => {
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
    markDirty()
  }

  function removeItem(clientId: string) {
    setItems((current) => current.filter((item) => item.clientId !== clientId))
    markDirty()
  }

  function markDirty() {
    setIsDirty(true)
    setIsConflict(false)
    setNotice(null)
  }

  async function saveDraft() {
    if (!collectionState || isSaving || isPublishing) return
    const validationError = validateEditorItems(items, collectionState.collection.defaultLimit)
    if (validationError) {
      setError(validationError)
      return
    }
    setIsSaving(true)
    setError(null)
    setNotice(null)
    setIsConflict(false)

    const payload: SavePolymarketCatalogDraftRequest = {
      expectedRevision: collectionState?.draft?.revision ?? null,
      items: items.map((item) => ({
        sourceKind: item.sourceKind,
        sourceSlug: item.sourceSlug.trim(),
        category: normalizedOptionalText(item.category),
        sport: normalizedOptionalText(item.sport),
        ruleConfig: isRuleKind(item.sourceKind) ? item.ruleConfig : undefined,
      })),
    }

    try {
      const response = await fetch(`${COLLECTION_ENDPOINT}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.status === 401) {
        window.location.reload()
        return
      }
      if (!response.ok) {
        if (response.status === 409) setIsConflict(true)
        throw new Error(await readableError(response))
      }
      applyCollectionState(await response.json() as PolymarketCatalogCollectionResponse)
      setIsDirty(false)
      setNotice('Draft saved. Review it, then publish when it is ready for the public collection.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the draft')
    } finally {
      setIsSaving(false)
    }
  }

  async function publishDraft() {
    const draft = collectionState?.draft
    if (!draft || isDirty || isSaving || isPublishing) return
    if (!window.confirm(`Publish featured collection draft v${draft.version} with ${draft.items.length} source${draft.items.length === 1 ? '' : 's'}?`)) {
      return
    }

    setIsPublishing(true)
    setError(null)
    setNotice(null)
    setIsConflict(false)
    const payload: PublishPolymarketCatalogDraftRequest = { expectedRevision: draft.revision }

    try {
      const response = await fetch(`${COLLECTION_ENDPOINT}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.status === 401) {
        window.location.reload()
        return
      }
      if (!response.ok) {
        if (response.status === 409) setIsConflict(true)
        throw new Error(await readableError(response))
      }
      applyCollectionState(await response.json() as PolymarketCatalogCollectionResponse)
      setIsDirty(false)
      setNotice('Featured collection published.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to publish the draft')
    } finally {
      setIsPublishing(false)
    }
  }

  async function logout() {
    await fetch('/internal/session', { method: 'DELETE', credentials: 'same-origin' })
    window.location.reload()
  }

  const draft = collectionState?.draft
  const published = collectionState?.published
  const canPublish = Boolean(draft && collectionState?.hasUnpublishedChanges && !isDirty)
  const collectionLimit = collectionState?.collection.defaultLimit ?? 20

  return (
    <main className={styles.catalogShell}>
      <header className={styles.topBar}>
        <div className={styles.brandRow}>
          <span className={styles.brandMark}>m</span>
          <div>
            <div className={styles.brandName}>myboon</div>
            <div className={styles.brandMeta}>internal catalog</div>
          </div>
        </div>
        <nav className={styles.topActions} aria-label="Internal dashboard">
          <Link className={styles.textButton} href="/internal/entities">
            <span className="material-symbols-outlined" aria-hidden="true">folder_open</span>
            Entities
          </Link>
          <button className={styles.textButton} type="button" onClick={logout}>
            <span className="material-symbols-outlined" aria-hidden="true">logout</span>
            Log out
          </button>
        </nav>
      </header>

      <section className={styles.pageHeading}>
        <div>
          <p className={styles.kicker}>Polymarket / collection</p>
          <h1>{collectionState?.collection.name ?? 'Featured markets'}</h1>
          <p>{collectionState?.collection.description ?? 'Control the ordered Polymarket markets shown by myboon without rebuilding the API.'}</p>
        </div>
        <div className={styles.releaseSummary}>
          <ReleaseBadge label="Draft" version={draft?.version} emptyLabel="Not saved" tone="draft" />
          <ReleaseBadge label="Published" version={published?.version} emptyLabel="None" tone="published" />
        </div>
      </section>

      {error ? (
        <div className={`${styles.message} ${styles.errorMessage}`} role="alert">
          <span>{error}</span>
          {isConflict ? (
            <button type="button" onClick={() => void loadCollection()}>Reload latest</button>
          ) : null}
        </div>
      ) : null}
      {notice ? <div className={`${styles.message} ${styles.noticeMessage}`} role="status">{notice}</div> : null}

      <section className={styles.editorGrid}>
        <div className={styles.mainColumn}>
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.sectionIndex}>01 / source</p>
                <h2>Add a Polymarket source</h2>
              </div>
              <span className={styles.itemCount}>{items.length} source{items.length === 1 ? '' : 's'}</span>
            </div>

            <div className={styles.sourceTabs} aria-label="Source mode">
              <button
                type="button"
                aria-pressed={form.sourceKind === 'sports_tag'}
                onClick={() => selectSourceMode('whole-sport')}
              >
                Whole sport
              </button>
              <button
                type="button"
                aria-pressed={form.sourceKind === 'sports_rule'}
                onClick={() => selectSourceMode('automatic')}
              >
                One league
              </button>
              <button
                type="button"
                aria-pressed={!isRuleKind(form.sourceKind)}
                onClick={() => selectSourceMode('individual')}
              >
                Individual slug
              </button>
            </div>

            <form className={`${styles.addForm} ${isRuleKind(form.sourceKind) ? styles.ruleForm : ''}`} onSubmit={addItem}>
              {form.sourceKind === 'sports_tag' ? (
                <>
                  <label className={styles.slugField}>
                    <span>Sport</span>
                    <select
                      value={form.sourceSlug}
                      onChange={(event) => setForm((current) => ({ ...current, sourceSlug: event.target.value }))}
                      required
                    >
                      <option value="cricket">Cricket — all leagues</option>
                    </select>
                    <small>Covers every league Polymarket tags for this sport, including ones added later.</small>
                  </label>
                  <label>
                    <span>Show next</span>
                    <div className={styles.suffixedInput}>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={form.windowDays}
                        onChange={(event) => setForm((current) => ({ ...current, windowDays: event.target.value }))}
                        required
                      />
                      <span>days</span>
                    </div>
                  </label>
                  <label>
                    <span>Maximum</span>
                    <div className={styles.suffixedInput}>
                      <input
                        type="number"
                        min={1}
                        max={Math.min(TAG_MAX_LIMIT, collectionLimit)}
                        value={form.limit}
                        onChange={(event) => setForm((current) => ({ ...current, limit: event.target.value }))}
                        required
                      />
                      <span>games</span>
                    </div>
                  </label>
                  <div className={styles.ruleInvariant}>
                    <span className="material-symbols-outlined" aria-hidden="true">public</span>
                    <span>All leagues · main games · live + upcoming · collection cap {collectionLimit}</span>
                  </div>
                </>
              ) : form.sourceKind === 'sports_rule' ? (
                <>
                  <label className={styles.slugField}>
                    <span>Polymarket sports code</span>
                    <input
                      value={form.sourceSlug}
                      onChange={(event) => setForm((current) => ({ ...current, sourceSlug: event.target.value.toLowerCase() }))}
                      placeholder="crint or epl"
                      list="polymarket-sport-codes"
                      autoComplete="off"
                      required
                    />
                    <datalist id="polymarket-sport-codes">
                      {sportsOptions.map((option) => (
                        <option key={option.sportCode} value={option.sportCode}>{option.label}</option>
                      ))}
                    </datalist>
                    {sportsOptionsError ? <small>Metadata list unavailable; a valid Polymarket code still works.</small> : null}
                  </label>
                  <label>
                    <span>Show next</span>
                    <div className={styles.suffixedInput}>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={form.windowDays}
                        onChange={(event) => setForm((current) => ({ ...current, windowDays: event.target.value }))}
                        required
                      />
                      <span>days</span>
                    </div>
                  </label>
                  <label>
                    <span>Maximum</span>
                    <div className={styles.suffixedInput}>
                      <input
                        type="number"
                        min={1}
                        max={Math.min(50, collectionLimit)}
                        value={form.limit}
                        onChange={(event) => setForm((current) => ({ ...current, limit: event.target.value }))}
                        required
                      />
                      <span>games</span>
                    </div>
                  </label>
                  <div className={styles.ruleInvariant}>
                    <span className="material-symbols-outlined" aria-hidden="true">autorenew</span>
                    <span>Main games · live + upcoming · collection cap {collectionLimit}</span>
                  </div>
                </>
              ) : (
                <>
                  <label>
                    <span>Source type</span>
                    <select
                      value={form.sourceKind}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        sourceKind: event.target.value as PolymarketCatalogSourceKind,
                      }))}
                    >
                      <option value="event">Event</option>
                      <option value="market">Market</option>
                    </select>
                  </label>
                  <label className={styles.slugField}>
                    <span>Polymarket slug</span>
                    <input
                      value={form.sourceSlug}
                      onChange={(event) => setForm((current) => ({ ...current, sourceSlug: event.target.value }))}
                      placeholder="nba-finals-2026"
                      autoComplete="off"
                      required
                    />
                  </label>
                  <label>
                    <span>Category <small>optional</small></span>
                    <input
                      value={form.category}
                      onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                      placeholder="Sports"
                      maxLength={64}
                    />
                  </label>
                  <label>
                    <span>Sport <small>{form.sourceKind === 'event' ? 'required' : 'optional'}</small></span>
                    <input
                      value={form.sport}
                      onChange={(event) => setForm((current) => ({ ...current, sport: event.target.value }))}
                      placeholder="Basketball"
                      maxLength={64}
                      required={form.sourceKind === 'event'}
                    />
                  </label>
                </>
              )}
              <button className={styles.addButton} type="submit">
                <span className="material-symbols-outlined" aria-hidden="true">add</span>
                Add source
              </button>
            </form>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.sectionIndex}>02 / order</p>
                <h2>Featured ledger</h2>
              </div>
              {isDirty ? <span className={styles.unsavedBadge}>Unsaved changes</span> : null}
            </div>

            {isLoading ? (
              <div className={styles.loadingState}>
                <span className={styles.spinner} aria-hidden="true" />
                Loading featured collection...
              </div>
            ) : items.length === 0 ? (
              <div className={styles.emptyState}>
                <span className="material-symbols-outlined" aria-hidden="true">playlist_add</span>
                <h3>No sources in this draft</h3>
                <p>Add an automatic competition or an individual slug above. An empty draft can also be saved and published intentionally.</p>
              </div>
            ) : (
              <ol className={styles.itemList}>
                {items.map((item, index) => (
                  <li className={styles.itemRow} key={item.clientId}>
                    <div className={styles.position}>{String(index + 1).padStart(2, '0')}</div>
                    <div className={styles.itemIdentity}>
                      <span className={styles.kindBadge}>
                        {item.sourceKind === 'sports_tag'
                          ? 'all leagues'
                          : item.sourceKind === 'sports_rule' ? 'auto' : item.sourceKind}
                      </span>
                      <strong>{item.title || item.sourceSlug}</strong>
                      <code>
                        {item.sourceKind === 'sports_tag'
                          ? `sport: ${item.sourceSlug}`
                          : item.sourceKind === 'sports_rule' ? `sport code: ${item.sourceSlug}` : item.sourceSlug}
                      </code>
                    </div>
                    {isRuleKind(item.sourceKind) && item.ruleConfig ? (
                      <div className={styles.ruleControls}>
                        <label className={styles.inlineField}>
                          <span>Next days</span>
                          <input
                            type="number"
                            min={1}
                            max={30}
                            value={item.ruleConfig.windowDays}
                            onChange={(event) => updateRuleItem(item.clientId, 'windowDays', event.target.value)}
                          />
                        </label>
                        <label className={styles.inlineField}>
                          <span>Max games</span>
                          <input
                            type="number"
                            min={1}
                            max={Math.min(item.sourceKind === 'sports_tag' ? TAG_MAX_LIMIT : 50, collectionLimit)}
                            value={item.ruleConfig.limit}
                            onChange={(event) => updateRuleItem(item.clientId, 'limit', event.target.value)}
                          />
                        </label>
                        <span className={styles.ruleSummary}>Main games · live + upcoming</span>
                      </div>
                    ) : (
                      <>
                        <label className={styles.inlineField}>
                          <span>Category</span>
                          <input
                            value={item.category ?? ''}
                            onChange={(event) => updateItem(item.clientId, 'category', event.target.value)}
                            maxLength={64}
                            placeholder="—"
                          />
                        </label>
                        <label className={styles.inlineField}>
                          <span>Sport</span>
                          <input
                            value={item.sport ?? ''}
                            onChange={(event) => updateItem(item.clientId, 'sport', event.target.value)}
                            maxLength={64}
                            placeholder="—"
                          />
                        </label>
                      </>
                    )}
                    <div className={styles.rowActions}>
                      <button type="button" onClick={() => moveItem(index, -1)} disabled={index === 0} aria-label={`Move ${item.sourceSlug} up`}>
                        <span className="material-symbols-outlined" aria-hidden="true">arrow_upward</span>
                      </button>
                      <button type="button" onClick={() => moveItem(index, 1)} disabled={index === items.length - 1} aria-label={`Move ${item.sourceSlug} down`}>
                        <span className="material-symbols-outlined" aria-hidden="true">arrow_downward</span>
                      </button>
                      <button className={styles.removeButton} type="button" onClick={() => removeItem(item.clientId)} aria-label={`Remove ${item.sourceSlug}`}>
                        <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className={styles.sideColumn}>
          <section className={styles.publishPanel}>
            <p className={styles.sectionIndex}>03 / release</p>
            <h2>Save, then publish</h2>
            <p>Saving resolves every source against Polymarket and creates a versioned draft. Automatic sources keep discovering matching games after publish.</p>

            <dl className={styles.releaseDetails}>
              <div>
                <dt>Collection</dt>
                <dd><code>{COLLECTION_KEY}</code></dd>
              </div>
              <div>
                <dt>Output cap</dt>
                <dd>{collectionState?.collection.defaultLimit ?? 20} markets</dd>
              </div>
              <div>
                <dt>Draft</dt>
                <dd>{draft ? `v${draft.version} · ${draft.items.length} sources` : 'Not saved'}</dd>
              </div>
              <div>
                <dt>Live</dt>
                <dd>{published ? `v${published.version} · ${published.items.length} sources` : 'Not published'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{releaseStatus(collectionState, isDirty)}</dd>
              </div>
            </dl>

            <button
              className={styles.saveButton}
              type="button"
              disabled={isLoading || !collectionState || !isDirty || isSaving || isPublishing}
              onClick={() => void saveDraft()}
            >
              {isSaving ? 'Saving draft...' : 'Save draft'}
            </button>
            <button
              className={styles.publishButton}
              type="button"
              disabled={!canPublish || isSaving || isPublishing}
              onClick={() => void publishDraft()}
            >
              {isPublishing ? 'Publishing...' : 'Publish saved draft'}
            </button>
            {isDirty ? <small>Save local changes before publishing.</small> : null}
            {!isDirty && draft && !collectionState?.hasUnpublishedChanges ? <small>The published revision is current.</small> : null}
          </section>

          <section className={styles.notePanel}>
            <span className="material-symbols-outlined" aria-hidden="true">info</span>
            <div>
              <strong>Ordered, not hard-coded</strong>
              <p>Sources run top to bottom. Keep must-show manual slugs above broad automatic sources so they cannot be pushed beyond the output cap.</p>
            </div>
          </section>
        </aside>
      </section>
    </main>
  )
}

function ReleaseBadge({ label, version, emptyLabel, tone }: {
  label: string
  version?: number
  emptyLabel: string
  tone: 'draft' | 'published'
}) {
  return (
    <div className={styles.releaseBadge} data-tone={tone}>
      <span>{label}</span>
      <strong>{version ? `v${version}` : emptyLabel}</strong>
    </div>
  )
}

function toEditorItem(item: PolymarketCatalogItem): EditorItem {
  return {
    clientId: item.id || createClientId(),
    sourceKind: item.sourceKind,
    sourceSlug: item.sourceSlug,
    title: item.title,
    category: item.category,
    sport: item.sport,
    ruleConfig: item.ruleConfig,
  }
}

function normalizedOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function createClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function releaseStatus(state: PolymarketCatalogCollectionResponse | null, isDirty: boolean): string {
  if (isDirty) return 'Local edits'
  if (state?.hasUnpublishedChanges) return 'Draft ready'
  if (state?.published) return 'Published'
  return 'Not published'
}

async function readableError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`
}

function validateEditorItems(items: EditorItem[], collectionLimit: number): string | null {
  for (const item of items) {
    if (item.sourceKind === 'event' && !normalizedOptionalText(item.sport)) {
      return `The event “${item.sourceSlug}” needs a sport before this draft can be saved.`
    }
    if (isRuleKind(item.sourceKind)) {
      const kindCeiling = item.sourceKind === 'sports_tag' ? TAG_MAX_LIMIT : 50
      const config = item.ruleConfig
      if (!config
        || !Number.isSafeInteger(config.windowDays)
        || config.windowDays < 1
        || config.windowDays > 30
        || !Number.isSafeInteger(config.limit)
        || config.limit < 1
        || config.limit > Math.min(kindCeiling, collectionLimit)) {
        return `The automatic source “${item.sourceSlug}” needs a valid window and a game limit no greater than the collection cap (${collectionLimit}).`
      }
    }
  }
  return null
}
