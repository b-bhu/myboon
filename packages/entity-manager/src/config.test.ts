import { describe, expect, it } from 'vitest';

import { mainRunConfig, marketsConfig, retryRunConfig } from './config.js';

describe('#621 mainRunConfig', () => {
  it('flag unset: the #593 behaviour, no scope and batch 20', () => {
    expect(mainRunConfig({})).toEqual({ scope: undefined, limit: 20 });
  });

  it('flag off (false, TRUE, 1, empty): still no scope; ENTITY_MANAGER_MAX_PER_RUN is honoured and the 60 batch is ignored', () => {
    for (const v of ['false', 'TRUE', '1', '']) {
      expect(mainRunConfig({ ENTITY_MANAGER_CLAIM_ENTITY_ONLY: v })).toEqual({ scope: undefined, limit: 20 });
    }
    expect(mainRunConfig({ ENTITY_MANAGER_MAX_PER_RUN: '20', ENTITY_MANAGER_ENTITY_ONLY_MAX_PER_RUN: '60' })).toEqual({ scope: undefined, limit: 20 });
    expect(mainRunConfig({ ENTITY_MANAGER_MAX_PER_RUN: '35' })).toEqual({ scope: undefined, limit: 35 });
  });

  it('flag on: claims only handoffs with an entity, batch 60', () => {
    expect(mainRunConfig({ ENTITY_MANAGER_CLAIM_ENTITY_ONLY: 'true' })).toEqual({ scope: 'entity', limit: 60 });
  });

  it('flag on: the 20 from the PM2 env does not cap the batch; only the entity-only knob changes it', () => {
    expect(mainRunConfig({ ENTITY_MANAGER_CLAIM_ENTITY_ONLY: 'true', ENTITY_MANAGER_MAX_PER_RUN: '20' }).limit).toBe(60);
    expect(mainRunConfig({ ENTITY_MANAGER_CLAIM_ENTITY_ONLY: 'true', ENTITY_MANAGER_ENTITY_ONLY_MAX_PER_RUN: '90' }).limit).toBe(90);
  });
});

describe('#621 retryRunConfig', () => {
  it('claims only no-entity handoffs, batch 2000 unless overridden', () => {
    expect(retryRunConfig({})).toEqual({ scope: 'no_entity', limit: 2000 });
    expect(retryRunConfig({ ENTITY_MANAGER_RETRY_MAX_PER_RUN: '500' })).toEqual({ scope: 'no_entity', limit: 500 });
  });
});

describe('#690 marketsConfig', () => {
  it('off by default: the run behaves as before the #690 feature', () => {
    expect(marketsConfig({})).toEqual({ enabled: false, limit: 10 });
  });

  it('on only for the exact string "true"', () => {
    expect(marketsConfig({ ENTITY_MANAGER_MARKETS_ENABLED: 'true' })).toEqual({ enabled: true, limit: 10 });
    for (const v of ['false', 'TRUE', '1', '', 'yes', ' true']) {
      expect(marketsConfig({ ENTITY_MANAGER_MARKETS_ENABLED: v }).enabled).toBe(false);
    }
  });

  it('limit defaults to 10 and ENTITY_MANAGER_MARKETS_MAX_PER_RUN overrides without touching enabled', () => {
    expect(marketsConfig({}).limit).toBe(10);
    expect(marketsConfig({ ENTITY_MANAGER_MARKETS_MAX_PER_RUN: '4' })).toEqual({ enabled: false, limit: 4 });
    expect(marketsConfig({ ENTITY_MANAGER_MARKETS_ENABLED: 'true', ENTITY_MANAGER_MARKETS_MAX_PER_RUN: '25' })).toEqual({ enabled: true, limit: 25 });
  });
});
