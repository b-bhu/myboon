/**
 * #582 paywall host blocklist (CTO decision 8). A matching link is marked
 * body_status='unavailable' without any fetch or Hermes call. The list lives
 * in code next to the matcher so it is easy to extend; hosts are matched
 * exactly or as a subdomain (www.reuters.com and mobile.reuters.com both
 * match reuters.com).
 */
export const PAYWALL_HOSTS: readonly string[] = [
  'reuters.com',
  'bloomberg.com',
  'wsj.com',
  'ft.com',
];

/** True when the link's hostname is one of the blocklist hosts or a subdomain of one. */
export function isPaywallHost(link: string, hosts: readonly string[] = PAYWALL_HOSTS): boolean {
  let hostname: string;
  try {
    hostname = new URL(link).hostname.toLowerCase();
  } catch {
    // An unparseable link is not a paywall match; it goes through the fetch path and fails there.
    return false;
  }
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}
