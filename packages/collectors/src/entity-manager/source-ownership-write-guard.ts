import { isAbsolute, resolve } from 'node:path'
import { requireSourceOwnership } from '../signal-platform/source-ownership'
import type { EntityMemoryStore } from './types'

export function legacyEntitySourcePath(source: 'news' | 'polymarket', env: Readonly<Record<string,string | undefined>> = process.env): string {
  const path = source === 'news' ? env.NEWS_SQLITE_PATH ?? '.data/news.sqlite' : env.PIPELINE_SQLITE_PATH ?? '.data/pipeline.sqlite'
  return isAbsolute(path) ? path : resolve(__dirname,'..','..',path)
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
