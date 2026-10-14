export interface TradeRecord {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  closedAt: number;
  type: 'market_close' | 'tp_trigger' | 'sl_trigger';
}

interface TradeHistoryStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

const TRADE_HISTORY_KEY = 'pnl:trade_history';

export function createTradeHistoryStore(storage: TradeHistoryStorage) {
  let saveQueue: Promise<void> = Promise.resolve();

  async function loadTradeHistory(): Promise<TradeRecord[]> {
    try {
      const raw = await storage.getItem(TRADE_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveTradeRecord(record: TradeRecord): Promise<void> {
    const save = saveQueue.then(async () => {
      const raw = await storage.getItem(TRADE_HISTORY_KEY);
      const existing: TradeRecord[] = raw ? JSON.parse(raw) : [];
      existing.unshift(record);
      if (existing.length > 100) existing.length = 100;
      await storage.setItem(TRADE_HISTORY_KEY, JSON.stringify(existing));
    });

    // Keep a rejected save visible to its caller without poisoning later saves.
    saveQueue = save.then(() => undefined, () => undefined);
    return save.catch((error: unknown) => {
      console.warn('[perps] Failed to save trade history', error);
      throw error;
    });
  }

  return { loadTradeHistory, saveTradeRecord };
}
