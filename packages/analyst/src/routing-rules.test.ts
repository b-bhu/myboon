/** #490 CTO nits: routing rules are validated when the runner loads them, and default to none. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_RULES, RoutingRuleError, linkerStory, validateRoutingRules, type RoutingRule } from './index.js';

const ok: RoutingRule = { tokenSlug: 'uni-token', projectSlug: 'uniswap', routeTo: 'uniswap' };

describe('routing rules load-time validation', () => {
  it('accepts a rule that routes to one side of its pair', () => {
    expect(validateRoutingRules([ok])).toEqual([ok]);
  });
  it.each<[string, RoutingRule]>([
    ['routeTo on neither side', { ...ok, routeTo: 'aave' }],
    ['token and project the same', { tokenSlug: 'uni', projectSlug: 'uni', routeTo: 'uni' }],
    ['empty slug', { ...ok, tokenSlug: ' ' }],
  ])('rejects %s with a RoutingRuleError', (_l, rule) => {
    expect(() => validateRoutingRules([rule])).toThrow(RoutingRuleError);
  });
  it('rejects the same pair twice, in either order', () => {
    expect(() => validateRoutingRules([ok, { tokenSlug: 'uniswap', projectSlug: 'uni-token', routeTo: 'uni-token' }])).toThrow(RoutingRuleError);
  });
  it('linkerStory refuses to start with a bad rule', () => {
    expect(() => linkerStory({ routingRules: [{ ...ok, routeTo: 'aave' }] })).toThrow(RoutingRuleError);
  });
});

describe('routing rules default', () => {
  it('is an empty list until Bucket provides the seed rules', () => {
    expect(DEFAULT_ROUTING_RULES).toEqual([]);
    expect(Object.isFrozen(DEFAULT_ROUTING_RULES)).toBe(true);
    expect(() => linkerStory()).not.toThrow();
  });
});
