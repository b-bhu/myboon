import { describe, expect, it, vi } from 'vitest';
import { runGatedStage } from '@myboon/shared/v4-runtime';

import { ENABLED_FLAG, loadRunConfig, parseVisibility, requireEnv } from './config.js';

describe('run config', () => {
  it('defaults: 24 h window, cap 25, 20 min budget, 30 s timeout, dark, glm-5.3-flash', () => {
    expect(loadRunConfig({})).toEqual({
      windowHours: 24, maxPerRun: 25, runBudgetMs: 1_200_000, timeoutMs: 30_000, concurrency: 2, visibility: 'dark', model: 'glm-5.3-flash',
    });
  });

  it('reads every knob from env', () => {
    expect(loadRunConfig({
      LATEST_UPDATES_WINDOW_HOURS: '48', LATEST_UPDATES_MAX_PER_RUN: '5', LATEST_UPDATES_RUN_BUDGET_MS: '60000',
      LATEST_UPDATES_TIMEOUT_MS: '9000', LATEST_UPDATES_CONCURRENCY: '3', LATEST_UPDATES_VISIBILITY: 'live', LATEST_UPDATES_LLM_MODEL: 'other',
    })).toEqual({ windowHours: 48, maxPerRun: 5, runBudgetMs: 60000, timeoutMs: 9000, concurrency: 3, visibility: 'live', model: 'other' });
  });

  it.each(['0', '-1', '1.5', 'abc', '1e3'])('rejects %s for a numeric knob, naming the key and not the value', (bad) => {
    expect(() => loadRunConfig({ LATEST_UPDATES_MAX_PER_RUN: bad })).toThrow('LATEST_UPDATES_MAX_PER_RUN must be a positive whole number');
  });

  it('caps concurrency', () => {
    expect(() => loadRunConfig({ LATEST_UPDATES_CONCURRENCY: '9' })).toThrow(/at most 4/);
  });

  it("visibility: unset or empty is 'dark'; only 'dark' and 'live' are valid; a bad value fails closed", () => {
    expect(parseVisibility(undefined)).toBe('dark');
    expect(parseVisibility('')).toBe('dark');
    expect(parseVisibility(' live ')).toBe('live');
    for (const bad of ['LIVE', 'true', '1', 'public']) expect(() => parseVisibility(bad)).toThrow("must be 'dark' or 'live'");
  });

  it('has no knob for the window basis', () => {
    const keys = Object.keys(loadRunConfig({}));
    expect(keys.some((k) => /basis|field|column/i.test(k))).toBe(false);
  });

  it('requireEnv names the key and never the value', () => {
    expect(() => requireEnv({}, 'LATEST_UPDATES_DATABASE_URL')).toThrow('LATEST_UPDATES_DATABASE_URL is required');
    expect(requireEnv({ K: ' v ' }, 'K')).toBe('v');
  });
});

describe('the LATEST_UPDATES_ENABLED gate', () => {
  const gate = (env: Record<string, string | undefined>) => {
    const run = vi.fn(async () => {});
    const exit = vi.fn();
    const log = vi.fn();
    return runGatedStage({ flag: ENABLED_FLAG, stage: 'latest-updates', env, run, exit: exit as never, log }).then(() => ({ run, exit, log }));
  };

  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])('off (%s): exits 0 and never runs, so config and the model are never touched', async (value) => {
    // Garbage in every other knob: a disabled job must not read or validate any of it.
    const { run, exit, log } = await gate({ [ENABLED_FLAG]: value, LATEST_UPDATES_MAX_PER_RUN: 'garbage', LATEST_UPDATES_VISIBILITY: 'garbage' });
    expect(run).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.mock.calls[0]![0]).toContain('latest-updates disabled');
  });

  it("on ('true'): runs", async () => {
    const { run, exit } = await gate({ [ENABLED_FLAG]: 'true' });
    expect(run).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
