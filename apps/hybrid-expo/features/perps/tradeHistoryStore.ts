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

export function makeTradeRecordId(symbol: string): string {
  return `${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseTradeHistory(raw: string | null): TradeRecord[] {
  if (!raw) return [];

  try {
    const history: unknown = JSON.parse(raw);
    if (Array.isArray(history)) return history as TradeRecord[];
  } catch (error) {
    console.warn('[perps] Failed to parse trade history; resetting it', error);
    return [];
  }

  console.warn('[perps] Stored trade history is not an array; resetting it');
  return [];
}

export function createTradeHistoryStore(storage: TradeHistoryStorage) {
  let saveQueue: Promise<void> = Promise.resolve();

  async function loadTradeHistory(): Promise<TradeRecord[]> {
    try {
      const raw = await storage.getItem(TRADE_HISTORY_KEY);
      return parseTradeHistory(raw);
    } catch {
      return [];
    }
  }

  function saveTradeRecord(record: TradeRecord): Promise<void> {
    const save = saveQueue.then(async () => {
      const raw = await storage.getItem(TRADE_HISTORY_KEY);
      const existing = parseTradeHistory(raw);
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
