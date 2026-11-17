/** Shapes shared by the runner, the checks and the eval script. */

export type Item = {
  id: string;
  title: string;
  summary: string | null;
  note: string | null;
  angle: string | null;
  occurred_at: string | null;
  created_at: string;
  signal_id: string | null;
};

export type Signal = {
  signal_id: string;
  type: string | null;
  source: string | null;
  text: string | null;
  excerpt: string | null;
  numbers: unknown;
  link: string | null;
  occurred_at: string | null;
  created_at: string | null;
};

/** The labelled parts of our last card, shown to the model and compared by the repeat check (#671). */
export type LastCard = { title: string; what_happened: string; how_we_got_here: string; what_to_watch: string };

type LastUpdateBase = {
  id: string;
  title: string | null;
  /** All the text of the last update, used by the novelty and period checks. */
  text: string;
  date: string | null;
};
/** What we last told readers: our own newest latest_updates row, or (none yet) the entity's newest earlier item. */
export type LastUpdate = (LastUpdateBase & { kind: 'published'; card: LastCard }) | (LastUpdateBase & { kind: 'earlier_item' });

export type Bundle = {
  entity: { id: string; slug: string; name: string; type: string; summary: string | null };
  /** The newest eligible item: with the entity it is the key of the decision. */
  newest_item_id: string;
  new_items: Item[];
  prior_items: Item[];
  origin_signals: Signal[];
  last_update: LastUpdate | null;
  /** The run's clock (ISO, UTC), set by loadBundle from the runner's `now`. The prompt and the time checks read it. */
  now: string;
};

export type Claim = { text: string; source_item_id: string | null; source_signal_id: string | null };

export type Draft = {
  title: string;
  what_happened: string;
  how_we_got_here: string;
  what_to_watch: string;
  claims: Claim[];
};

export type CheckName = 'novelty' | 'claims' | 'numbers' | 'watch' | 'period' | 'repeat_previous' | 'stale_timeframe';
export type CheckFailure = { check: CheckName; detail: string };

export type ModelDecision =
  | { decision: 'hold' | 'skip'; reason: string }
  | { decision: 'write'; reason: string; draft: Draft };

export type ErrorCode = 'timeout' | 'bad_json' | 'llm_error';
export type EditorOutcome =
  | { kind: 'decision'; model: ModelDecision }
  | { kind: 'error'; code: ErrorCode; message: string };
