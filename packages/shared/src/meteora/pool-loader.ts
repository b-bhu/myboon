export interface MeteoraPoolLoader<T> {
  get(poolAddress: string): Promise<T>
  getFresh(poolAddress: string): Promise<T>
  clear(): void
}

/**
 * Cache completed pool loads, while sharing concurrent fresh loads. A fresh
 * request never reuses a completed cached value, and a failed fresh request
 * does not leave stale state behind.
 */
export function createMeteoraPoolLoader<T>(
  load: (poolAddress: string) => Promise<T>,
): MeteoraPoolLoader<T> {
  const cached = new Map<string, Promise<T>>()
  const refreshing = new Map<string, Promise<T>>()

  const loadCached = (poolAddress: string): Promise<T> => {
    const existing = cached.get(poolAddress)
    if (existing) return existing

    let promise: Promise<T>
    promise = Promise.resolve().then(() => load(poolAddress)).catch((cause) => {
      if (cached.get(poolAddress) === promise) cached.delete(poolAddress)
      throw cause
    })
    cached.set(poolAddress, promise)
    return promise
  }

  const get = (poolAddress: string): Promise<T> => {
    return refreshing.get(poolAddress) ?? loadCached(poolAddress)
  }

  const getFresh = (poolAddress: string): Promise<T> => {
    const existing = refreshing.get(poolAddress)
    if (existing) return existing

    // Do not expose the previous value as the result of this request. Other
    // callers can still join this in-flight refresh through get().
    cached.delete(poolAddress)
    let promise: Promise<T>
    promise = Promise.resolve().then(() => load(poolAddress)).then(
      (value) => {
        if (refreshing.get(poolAddress) === promise) {
          cached.set(poolAddress, Promise.resolve(value))
          refreshing.delete(poolAddress)
        }
        return value
      },
      (cause) => {
        if (refreshing.get(poolAddress) === promise) {
          cached.delete(poolAddress)
          refreshing.delete(poolAddress)
        }
        throw cause
      },
    )
    refreshing.set(poolAddress, promise)
    return promise
  }

  return {
    get,
    getFresh,
    clear() {
      cached.clear()
      refreshing.clear()
    },
  }
}
