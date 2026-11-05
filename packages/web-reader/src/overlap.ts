/**
 * #582 overlap guard: a proposed body is kept only when it shares enough
 * lowercase word tokens with what we already know (the signal title, or a
 * plain-fetched page extract). Bodies with no overlap are dropped as likely
 * hallucinations (the Nov 5 10-outlet test's unverifiable The Defiant case).
 * Token = a run of letters/digits of length >= 4, lowercased.
 */
export const MIN_OVERLAP_TOKENS = 2;
export const MIN_TOKEN_LENGTH = 4;

/** Lowercase letter/digit runs of at least four characters. */
export function normalizeTokens(text: string | null | undefined, minLen = MIN_TOKEN_LENGTH): Set<string> {
  const matches = (text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matches) return new Set();
  return new Set(matches.filter((token) => token.length >= minLen));
}

function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared;
}

/**
 * Shared lowercase word tokens (length >= 4) decide: the body must share at
 * least `minShared` tokens with the title, or with the plain-fetched extract
 * when one exists.
 */
export function hasEnoughOverlap(
  body: string,
  title: string | null | undefined,
  plainExtract?: string | null | undefined,
  minShared: number = MIN_OVERLAP_TOKENS,
): boolean {
  const bodyTokens = normalizeTokens(body);
  if (bodyTokens.size === 0) return false;
  if (sharedTokenCount(bodyTokens, normalizeTokens(title)) >= minShared) return true;
  if (plainExtract) {
    if (sharedTokenCount(bodyTokens, normalizeTokens(plainExtract)) >= minShared) return true;
  }
  return false;
}
