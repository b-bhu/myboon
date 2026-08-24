import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'predict_quick_amounts_v1';
export const DEFAULT_PREDICT_QUICK_AMOUNTS = [5, 10, 20] as const;

function normalize(values: unknown): number[] | null {
  if (!Array.isArray(values) || values.length !== 3) return null;
  const parsed = values.map(Number);
  if (parsed.some((value) => !Number.isFinite(value) || value <= 0 || value > 10_000)) return null;
  return parsed.map((value) => Math.round(value * 100) / 100);
}

export function usePredictQuickAmounts() {
  const [quickAmounts, setQuickAmountsState] = useState<number[]>([...DEFAULT_PREDICT_QUICK_AMOUNTS]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!active || !stored) return;
        const next = normalize(JSON.parse(stored));
        if (next) setQuickAmountsState(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => { active = false; };
  }, []);

  const setQuickAmounts = useCallback(async (values: number[]) => {
    const next = normalize(values);
    if (!next) throw new Error('Enter three amounts greater than $0.');
    setQuickAmountsState(next);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  return { quickAmounts, setQuickAmounts, hydrated };
}
