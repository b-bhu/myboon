import type { PendingSwapExecution } from '@/features/swap/swap.types';

const STORAGE_KEY = '@myboon/swap/pending/v1';

export interface SwapPendingStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface SwapPendingStore {
  list(walletAddress?: string): Promise<PendingSwapExecution[]>;
  save(value: PendingSwapExecution): Promise<void>;
  remove(requestId: string): Promise<void>;
}

/** A transaction cannot land once Solana advances beyond its validity window. */
export function isPendingSwapExpired(
  value: Pick<PendingSwapExecution, 'lastValidBlockHeight'>,
  currentBlockHeight: number | bigint,
): boolean {
  const lastValid = value.lastValidBlockHeight;
  if (!lastValid || !/^(?:0|[1-9][0-9]*)$/.test(lastValid)) return false;
  return BigInt(currentBlockHeight) > BigInt(lastValid);
}

function isPending(value: unknown): value is PendingSwapExecution {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PendingSwapExecution>;
  return row.version === 1
    && typeof row.requestId === 'string'
    && typeof row.walletAddress === 'string'
    && typeof row.inputMint === 'string'
    && typeof row.outputMint === 'string'
    && typeof row.inAmountAtomic === 'string'
    && typeof row.minimumOutAmountAtomic === 'string'
    && (row.signature === null || typeof row.signature === 'string')
    && (row.lastValidBlockHeight === null || typeof row.lastValidBlockHeight === 'string')
    && (row.outcome === 'submitted' || row.outcome === 'unknown')
    && typeof row.createdAt === 'string'
    && typeof row.updatedAt === 'string';
}

export function createMemorySwapPendingStorage(): SwapPendingStorage {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => { data.set(key, value); },
  };
}

export function createNativeSwapPendingStorage(): SwapPendingStorage {
  async function storage() {
    return (await import('@react-native-async-storage/async-storage')).default;
  }
  return {
    getItem: async (key) => (await storage()).getItem(key),
    setItem: async (key, value) => { await (await storage()).setItem(key, value); },
  };
}

export function createSwapPendingStore(
  storage: SwapPendingStorage = createNativeSwapPendingStorage(),
): SwapPendingStore {
  let writeChain = Promise.resolve();

  async function read(): Promise<PendingSwapExecution[]> {
    const raw = await storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isPending) : [];
    } catch {
      return [];
    }
  }

  function update(mutator: (rows: PendingSwapExecution[]) => PendingSwapExecution[]): Promise<void> {
    writeChain = writeChain.then(async () => {
      const rows = await read();
      await storage.setItem(STORAGE_KEY, JSON.stringify(mutator(rows)));
    });
    return writeChain;
  }

  return {
    async list(walletAddress) {
      await writeChain;
      const rows = await read();
      const selected = walletAddress
        ? rows.filter((row) => row.walletAddress === walletAddress)
        : rows;
      return selected.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
    save(value) {
      if (!isPending(value)) return Promise.reject(new Error('Pending swap record is invalid.'));
      return update((rows) => [value, ...rows.filter((row) => row.requestId !== value.requestId)]);
    },
    remove(requestId) {
      return update((rows) => rows.filter((row) => row.requestId !== requestId));
    },
  };
}
