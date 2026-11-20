/**
 * #690 pure markets logic: the system prompt, the user message and the reply validation.
 * No DB, no network. The prompt asks for the 0 to 3 Hyperliquid markets the subject most directly
 * moves; validation keeps only exact live symbols, dedupes, caps at 3 and normalises reasons, so
 * the write step can never fail on a bad symbol, a duplicate or an over-long reason. Zero picks
 * (an empty list, or every pick dropped as unknown) is a valid answer, so a bad entity cannot
 * loop forever; only an unusable reply shape throws (the entity stays unchecked for the next run).
 */
import type { EntityRow, RecentItem } from './decide.js';

export type MarketPick = { symbol: string; reason: string | null };

/** #690: at most 3 links per entity (the atlas.entity_markets check allows ranks 1..3). */
export const MAX_MARKET_PICKS = 3;
/** #690: one short reason; the DB check allows 1..200 characters and no newline. */
export const MARKET_REASON_MAX = 200;

export const MARKETS_SYSTEM_PROMPT = `You pick the Hyperliquid markets that one subject most directly moves.

You get:
- SUBJECT: name, type, summary.
- RECENT ITEMS: the subject's latest item titles, newest first (may be missing).
- LIVE SYMBOLS: every live Hyperliquid market as the API returns it — core tokens (BTC, ETH, kPEPE) and builder-deployed ones (xyz:CL, xyz:SP500). Symbols are exact: copy them character for character, case included.

Your job:
- Pick the 0 to 3 Hyperliquid markets whose price this subject most directly moves, most important first.
- Use only symbols from the list, copied exactly. A company with its own listed stock uses that stock. A token uses its own perp. A geopolitical or macro story uses the macro market it moves (e.g. a US–Iran conflict → xyz:CL, xyz:BRENTOIL).
- Return none rather than a weak link. Most subjects move no listed market; zero picks is a good answer.

Reply only JSON:
{"markets":[{"symbol":"xyz:CL","reason":"one line, under 200 characters"}]}`;

export function marketsUserMessage(entity: EntityRow, items: RecentItem[], symbols: readonly string[]): string {
  return [
    'SUBJECT:',
    `name: ${entity.name}`,
    `type: ${entity.type}`,
    `summary: ${entity.summary ?? '(none)'}`,
    '',
    'RECENT ITEMS:',
    ...(items.length ? items.map((it, i) => `${i + 1}. ${it.title}`) : ['(none yet)']),
    '',
    `LIVE SYMBOLS (${symbols.length}):`,
    ...symbols,
  ].join('\n');
}

/** One line, no newline, at most MARKET_REASON_MAX characters; empty or non-string becomes null. */
export function cleanMarketReason(reason: unknown): string | null {
  const s = typeof reason === 'string' ? reason.replace(/\r\n?|\n/g, ' ') : '';
  return s.trim().slice(0, MARKET_REASON_MAX) || null;
}

export type ValidateMarketsResult = { picks: MarketPick[]; dropped: string[] };

/**
 * Validate a parsed model reply against the live symbol set. Only exact matches survive
 * (case-sensitive); unknown symbols are returned in `dropped` for the log, duplicates are dropped
 * keeping the first, at most MAX_MARKET_PICKS survive in reply order for ranks 1..n. Throws only
 * for an unusable reply: no markets array, or an entry without a symbol.
 */
export function validateMarkets(reply: Record<string, unknown>, live: ReadonlySet<string>): ValidateMarketsResult {
  if (!Array.isArray(reply.markets)) throw new Error('LLM reply has no markets array');
  const picks: MarketPick[] = [];
  const kept = new Set<string>();
  const dropped: string[] = [];
  for (const entry of reply.markets as unknown[]) {
    const symbol = entry && typeof entry === 'object' && typeof (entry as { symbol?: unknown }).symbol === 'string'
      ? (entry as { symbol: string }).symbol.trim()
      : '';
    if (!symbol) throw new Error('LLM reply markets has an entry without a symbol');
    if (!live.has(symbol)) {
      dropped.push(symbol);
      continue;
    }
    if (kept.has(symbol) || picks.length >= MAX_MARKET_PICKS) continue;
    kept.add(symbol);
    picks.push({ symbol, reason: cleanMarketReason((entry as { reason?: unknown }).reason) });
  }
  return { picks, dropped };
}
