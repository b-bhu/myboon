import { resolve } from 'node:path'
import { resolveLaneSqlitePath } from '../lane-store/paths'
import { requireSourceOwnership } from '../signal-platform/source-ownership'
import type { EntityMemoryStore } from './types'

export function legacyEntitySourcePath(source: 'news' | 'polymarket', env: Readonly<Record<string,string | undefined>> = process.env): string {
  const configured = source === 'news' ? env.NEWS_SQLITE_PATH : env.PIPELINE_SQLITE_PATH
  return resolveLaneSqlitePath(source, configured, { baseDir: resolve(__dirname, '..', '..') })
}

export function legacyEntityWriteGuard(source: 'news' | 'polymarket', env: Readonly<Record<string,string | undefined>> = process.env): () => void {
  return () => requireSourceOwnership({databasePath: legacyEntitySourcePath(source,env),source,domain:'entity',owner:'legacy',env})
}

/** Fence every final legacy mutation, including writes after a long model call. */
export function ownershipGuardedEntityStore(store: EntityMemoryStore, assertOwned: () => void): EntityMemoryStore {
  const mutations = new Set<keyof EntityMemoryStore>(['createCanonicalEntity','createEntities','updateEntity','upsertMemories','updateMemory','recordManualCommand'])
  return new Proxy(store,{
    get(target,property,receiver) {
      const value: unknown = Reflect.get(target,property,receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (mutations.has(property as keyof EntityMemoryStore)) assertOwned()
        return Reflect.apply(value,target,args)
      }
    },
  })
}
