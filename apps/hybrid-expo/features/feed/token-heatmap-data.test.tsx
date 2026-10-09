import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useTokenHeatmap } from './use-token-heatmap';
import type { HeatmapInterval, TokenHeatmapResult } from './token-heatmap.types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const result = (interval: HeatmapInterval, volume = 100): TokenHeatmapResult => ({
  chain: 'solana', interval, limit: 20, source: 'jupiter', status: 'ready', stale: false, partial: false,
  fetchedAt: '2026-10-07T10:00:00Z', nextRefreshAt: '2026-10-07T10:05:00Z',
  tokens: [{ address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana', volumeUsd: volume,
    priceUsd: 100, priceChangePct: -1, marketCapUsd: null, liquidityUsd: null }],
});

test('interval changes hide the previous period, abort late results, and retain only same-period data on refresh failure', async () => {
  let fetchNext = async (interval: HeatmapInterval, _signal?: AbortSignal) => result(interval);
  const fetcher = (interval: HeatmapInterval, signal?: AbortSignal) => fetchNext(interval, signal);
  let section!: ReturnType<typeof useTokenHeatmap>;
  const readData = () => section.data;
  let observedOnRender: TokenHeatmapResult | null | undefined;
  function Harness({ interval, active = true }: { interval: HeatmapInterval; active?: boolean }) {
    section = useTokenHeatmap(interval, active, fetcher);
    observedOnRender = section.data;
    return null;
  }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness, { interval: '24h' })); });
    assert.equal(section.data?.interval, '24h');
    let resolveOld!: (value: TokenHeatmapResult) => void;
    let oldSignal!: AbortSignal;
    fetchNext = (_interval, signal) => { oldSignal = signal!; return new Promise((resolve) => { resolveOld = resolve; }); };
    let oldRequest!: Promise<void>;
    await act(async () => { oldRequest = section.load(); });
    let resolveNew!: (value: TokenHeatmapResult) => void;
    fetchNext = () => new Promise((resolve) => { resolveNew = resolve; });
    await act(async () => { renderer.update(createElement(Harness, { interval: '1h' })); });
    assert.equal(oldSignal.aborted, true);
    assert.equal(observedOnRender, null);
    assert.equal(section.data, null);
    assert.equal(section.loading, true);
    await act(async () => { resolveOld(result('24h', 999)); await oldRequest; resolveNew(result('1h', 25)); });
    assert.equal(readData()?.interval, '1h');
    assert.equal(readData()?.tokens[0]?.volumeUsd, 25);
    fetchNext = async () => { throw new Error('offline'); };
    await act(async () => { await section.load(); });
    assert.equal(section.error, 'offline');
    assert.equal(readData()?.interval, '1h');
    await act(async () => { renderer.update(createElement(Harness, { interval: '6h' })); });
    assert.equal(section.data, null);
    assert.equal(section.error, 'offline');
    fetchNext = async (interval) => result(interval, 55);
    await act(async () => { await section.load(); });
    assert.equal(readData()?.interval, '6h');
    assert.equal(readData()?.tokens[0]?.volumeUsd, 55);
    assert.equal(section.error, null);
    let inactiveSignal!: AbortSignal;
    let resolveInactive!: (value: TokenHeatmapResult) => void;
    fetchNext = (_interval, signal) => { inactiveSignal = signal!; return new Promise((resolve) => { resolveInactive = resolve; }); };
    let inactiveRequest!: Promise<void>;
    await act(async () => { inactiveRequest = section.load(); });
    await act(async () => { renderer.update(createElement(Harness, { interval: '6h', active: false })); });
    assert.equal(inactiveSignal.aborted, true);
    await act(async () => { resolveInactive(result('6h', 999)); await inactiveRequest; });
    assert.equal(readData()?.tokens[0]?.volumeUsd, 55);
    assert.equal(section.loading, false);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});
