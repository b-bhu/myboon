import { describe, expect, test } from 'vitest';

import { isPaywallHost, PAYWALL_HOSTS } from './paywall.js';

describe('paywall blocklist (#582)', () => {
  test('blocks CTO list hosts and www. variants plus subdomains, case-insensitively', () => {
    for (const host of PAYWALL_HOSTS) {
      expect(isPaywallHost(`https://${host}/article`), host).toBe(true);
      expect(isPaywallHost(`https://www.${host}/article`), `www.${host}`).toBe(true);
      expect(isPaywallHost(`https://MOBILE.${host.toUpperCase()}/a`), `mobile upper ${host}`).toBe(true);
    }
  });

  test('does not over-block lookalike hosts or the rest of the web', () => {
    expect(isPaywallHost('https://notreuters.com/a')).toBe(false);
    expect(isPaywallHost('https://reuters.com.evil.test/a')).toBe(false);
    expect(isPaywallHost('https://cointelegraph.com/news/x')).toBe(false);
  });

  test('unparseable links are not paywalled (they fail in the fetch path instead)', () => {
    expect(isPaywallHost('not a url')).toBe(false);
    expect(isPaywallHost('')).toBe(false);
  });
});
