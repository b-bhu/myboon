/**
 * usePolymarketSettings — the Polymarket profile screen's settings-sheet
 * state machine (#740, extracted verbatim from `polymarket.portfolio.tsx`).
 *
 * Owns the sheet's open / view state, the profile currency (display choice,
 * the background USD→INR rate and its 6-hour refresh), the quick-amounts
 * draft and the MyBoon sign-out flow. The screen and
 * `PolymarketSettingsSheet` both read it, so the pasted sheet JSX is one
 * copy. Pure move — no behaviour change: every callback keeps its original
 * dependency array, and `dismissSettings` stays a stable `() => void` for
 * `usePolymarketAccountSetup` (it closes the sheet without clearing errors;
 * `closeSettings` is the user-facing close that does).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

import {
  fetchUsdToInrRate,
  POLYMARKET_PROFILE_CURRENCY_KEY,
  POLYMARKET_PROFILE_FALLBACK_USD_TO_INR,
  type PolymarketProfileCurrency,
  type PolymarketSettingsView,
} from '@/features/portfolio/polymarket/polymarket.format';
import { usePolymarketQuickAmounts } from '@/features/polymarket/usePolymarketQuickAmounts';
import type { PrivyWalletState } from '@/hooks/usePrivyWallet';

interface UsePolymarketSettingsOptions {
  privyDisconnect: PrivyWalletState['disconnect'];
}

export function usePolymarketSettings({ privyDisconnect }: UsePolymarketSettingsOptions) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<PolymarketSettingsView>('menu');
  const [usdToInrRate, setUsdToInrRate] = useState(POLYMARKET_PROFILE_FALLBACK_USD_TO_INR);
  const [currencyFormat, setCurrencyFormat] = useState<PolymarketProfileCurrency>('INR');
  const { quickAmounts, setQuickAmounts } = usePolymarketQuickAmounts();
  const [quickAmountDraft, setQuickAmountDraft] = useState(() => quickAmounts.map(String));
  const [quickAmountError, setQuickAmountError] = useState<string | null>(null);
  const [quickAmountSaving, setQuickAmountSaving] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const dismissSettings = useCallback(() => setSettingsOpen(false), []);

  const openSettings = useCallback(() => {
    setSettingsView('menu');
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(POLYMARKET_PROFILE_CURRENCY_KEY)
      .then((stored) => {
        if (stored === 'USD' || stored === 'INR') setCurrencyFormat(stored);
      })
      .catch(() => {});
  }, []);

  const selectCurrencyFormat = useCallback((next: PolymarketProfileCurrency) => {
    setCurrencyFormat(next);
    setSettingsOpen(false);
    setSettingsView('menu');
    AsyncStorage.setItem(POLYMARKET_PROFILE_CURRENCY_KEY, next).catch(() => {});
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsView('menu');
    setQuickAmountError(null);
    setSignOutError(null);
  }, []);

  const handleSignOut = useCallback(async () => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setSignOutError(null);
    try {
      await privyDisconnect();
      closeSettings();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : 'Could not sign out. Try again.');
    } finally {
      setSignOutBusy(false);
    }
  }, [closeSettings, privyDisconnect, signOutBusy]);

  useEffect(() => {
    if (settingsOpen && settingsView === 'amounts') {
      setQuickAmountDraft(quickAmounts.map(String));
      setQuickAmountError(null);
    }
  }, [quickAmounts, settingsOpen, settingsView]);

  const saveQuickAmounts = useCallback(async () => {
    setQuickAmountSaving(true);
    setQuickAmountError(null);
    try {
      await setQuickAmounts(quickAmountDraft.map((value) => Number.parseFloat(value)));
      setSettingsView('menu');
    } catch (error) {
      setQuickAmountError(error instanceof Error ? error.message : 'Could not save quick amounts.');
    } finally {
      setQuickAmountSaving(false);
    }
  }, [quickAmountDraft, setQuickAmounts]);

  useEffect(() => {
    let cancelled = false;
    async function refreshRate() {
      const rate = await fetchUsdToInrRate();
      if (!cancelled && rate !== null) setUsdToInrRate(rate);
    }
    void refreshRate();
    const interval = setInterval(() => void refreshRate(), 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return {
    open: settingsOpen,
    /** Raw setter — the identity header's gear tap opens the sheet directly. */
    setSettingsOpen,
    view: settingsView,
    /** Raw setter — the identity header and the sheet navigate between views. */
    setSettingsView,
    /** Replaced the two top-bar lambdas: reset to menu, then open. */
    openSettings,
    dismissSettings,
    closeSettings,
    currencyFormat,
    usdToInrRate,
    selectCurrencyFormat,
    quickAmounts,
    quickAmountDraft,
    setQuickAmountDraft,
    quickAmountError,
    quickAmountSaving,
    saveQuickAmounts,
    signOutBusy,
    signOutError,
    handleSignOut,
  };
}
