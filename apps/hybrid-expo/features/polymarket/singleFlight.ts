export interface SingleFlightLock {
  active: boolean;
}

export function createSingleFlightLock(): SingleFlightLock {
  return { active: false };
}

/** Synchronous acquisition prevents two activations before React can render. */
export async function runSingleFlight<T>(
  lock: SingleFlightLock,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (lock.active) return undefined;
  lock.active = true;
  try {
    return await operation();
  } finally {
    lock.active = false;
  }
}
