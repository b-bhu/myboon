import type { Signal } from '../signal.js';
import { SIGNAL_SCHEMA_VERSION } from '../signal.js';
import { rawHash, signalId } from '../ids.js';

/**
 * Real public news articles read from production (issue #440 samples).
 * Field names are kept verbatim from the source rows.
 */
export interface NewsSampleRow {
  source: string;
  source_ref_id: string;
  title: string;
  summary: string;
  event_at: string;
  observed_at: string;
}

/**
 * DB-style timestamp like '2026-09-09 23:00:00+00' (always UTC) ->
 * ISO '2026-09-09T23:00:00.000Z' style string accepted by the schema.
 */
function dbTimestampToIso(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00$/.exec(value);
  if (!match) {
    throw new Error(`Unexpected timestamp format in news samples: ${value}`);
  }
  return `${match[1]}T${match[2]}Z`;
}

export const newsSampleRows: readonly NewsSampleRow[] = [
  {
    source: 'manual',
    source_ref_id: 'https://apnews.com/article/22e6bda83c39b6c84a141053c5c95f97',
    title:
      'Trump proposed a conditional $5,000 payment to U.S. adults after the 2026 midterms',
    summary:
      'Trump pledged $5,000 per adult citizen if Republicans retain both chambers; the proposal was not enacted, would likely cost more than $1T, requires Congress and substantially exceeds available tariff revenue.',
    event_at: '2026-09-09 23:00:00+00',
    observed_at: '2026-09-10 14:31:21+00',
  },
  {
    source: 'news',
    source_ref_id:
      'https://cryptobriefing.com/pence-us-must-prepare-for-inevitable-military-action-against-iran',
    title:
      "Polymarket US-Iran 2026 deal markets: reconstruction-funding component 17.5% YES, final nuclear deal by Dec 31 9.5%",
    summary:
      "Live Polymarket component markets under the 'What will be in a US-Iran deal in 2026?' event priced YES at 8.5%-15.5% on Aug 26, 2026 (uranium surrender 8.5%, enrichment moratorium 12.5%, <=5% enrichment cap 12.5%, reconstruction funding 15.5%), while a Crypto Briefing article's reference to odds falling to 16.5% YES named no platform, contract, or timestamp.",
    event_at: '2026-08-26 12:05:45+00',
    observed_at: '2026-08-26 12:05:45+00',
  },
  {
    source: 'news',
    source_ref_id:
      'https://cryptobriefing.com/rep-al-green-files-impeachment-articles-against-trump-ahead-of-2026-midterms',
    title:
      "Polymarket 'Trump out as President before 2027?' priced 6.5% YES around the Aug 24 impeachment filing",
    summary:
      "The Polymarket market 'Trump out as President before 2027?' showed YES = 0.065 / NO = 0.935 as of 2026-08-26 ~03:45 UTC, with hourly prices in an approximately 0.055-0.085 band between August 23 and August 26, 2026, spanning Rep. Al Green's August 24 impeachment filing against President Trump.",
    event_at: '2026-08-26 03:43:23.589+00',
    observed_at: '2026-08-24 16:27:36.452+00',
  },
];

/**
 * The three rows mapped to V4 news signals (schema_version 1):
 * text = title, excerpt = summary, link/source_id = source_ref_id,
 * signal_id/raw_hash computed with the exported helpers.
 */
export const newsSampleSignals: readonly Signal[] = newsSampleRows.map((row) => ({
  schema_version: SIGNAL_SCHEMA_VERSION,
  signal_id: signalId(row.source, row.source_ref_id),
  source: row.source,
  source_id: row.source_ref_id,
  occurred_at: dbTimestampToIso(row.event_at),
  fetched_at: dbTimestampToIso(row.observed_at),
  type: 'news',
  priority: 0,
  text: row.title,
  numbers: {},
  link: row.source_ref_id,
  raw_ids: {},
  unusual_score: null,
  excerpt: row.summary,
  raw_hash: rawHash(JSON.stringify(row)),
}));